from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import sys
import tempfile
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import certifi
import pandas as pd
from curl_cffi import CurlOpt, requests

from legacy_provider.data import atomic_json
from legacy_provider.official_data import OFFICIAL_VERSION, audit_prices, download_0050, download_fx, nontrading_rows


@contextmanager
def market_session():
    with tempfile.TemporaryDirectory(prefix="steadyfolio-ca-") as folder:
        ca_path = Path(folder) / "cacert.pem"
        shutil.copyfile(certifi.where(), ca_path)
        ca_name = str(ca_path)
        if sys.platform == "win32":
            import ctypes
            buffer = ctypes.create_unicode_buffer(32768)
            if ctypes.windll.kernel32.GetShortPathNameW(ca_name, buffer, len(buffer)):
                ca_name = buffer.value
            encoded = ca_name.encode("mbcs")
        else:
            encoded = ca_name.encode()
        with requests.Session(impersonate="chrome", verify=True, curl_options={CurlOpt.CAINFO: encoded}) as session:
            yield session


def read_cache(root, symbol):
    key = hashlib.sha256(symbol.encode()).hexdigest()[:20]
    csv_path = root / f"{key}.csv"
    meta_path = root / f"{key}.json"
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    if metadata.get("symbol") != symbol or hashlib.sha256(csv_path.read_bytes()).hexdigest() != metadata.get("sha256"):
        raise ValueError(f"Invalid cached data hash or symbol: {symbol}")
    if symbol in ("0050.TW", "TWD=X") and metadata.get("data_version") != OFFICIAL_VERSION:
        raise ValueError(f"Obsolete official-data cache: {symbol}")
    if metadata.get("currency") not in ("TWD", "USD"):
        raise ValueError(f"Missing quote currency: {symbol}")
    return pd.read_csv(csv_path, index_col=0, parse_dates=True), metadata


def refresh(symbol, start, end, cache_root):
    with market_session() as session:
        if symbol == "0050.TW":
            return download_0050(SimpleNamespace(root=cache_root), start, end, session, lambda message: print(message, file=sys.stderr), lambda: None)
        if symbol == "TWD=X":
            return download_fx(start, end, session)
        import yfinance as yf
        yf.set_tz_cache_location(str(cache_root / "yfinance"))
        ticker = yf.Ticker(symbol, session=session)
        frame = ticker.history(start=start, end=(date.fromisoformat(end) + timedelta(days=1)).isoformat(), interval="1d", auto_adjust=False, actions=True, timeout=25, raise_errors=True)
        if frame is None or frame.empty or "Adj Close" not in frame:
            raise ValueError(f"No adjusted data returned for {symbol}")
        currency = (ticker.history_metadata or {}).get("currency")
        if currency not in ("TWD", "USD"):
            raise ValueError(f"Unverified currency for {symbol}")
        frame.index = pd.to_datetime(frame.index).tz_localize(None).normalize()
        return frame, {"currency": currency, "source": "Yahoo Finance / yfinance"}


def convert(symbol, frame, metadata, start, end):
    frame = frame.loc[start:end].sort_index()
    frame = frame.loc[~nontrading_rows(symbol, frame.index)]
    column = "Close" if symbol == "TWD=X" else "Adj Close"
    if column not in frame or len(frame) < 3 or frame.index.has_duplicates:
        raise ValueError(f"Missing or duplicated adjusted observations: {symbol}")
    rows = [[stamp.date().isoformat(), float(value)] for stamp, value in frame[column].items()]
    if any(not math.isfinite(row[1]) or row[1] <= 0 for row in rows):
        raise ValueError(f"Non-finite, missing or nonpositive prices: {symbol}")
    findings = audit_prices(symbol, frame, column)
    result = {"symbol": "USDTWD" if symbol == "TWD=X" else symbol,
              "name": symbol, "currency": metadata["currency"],
              "market": "FX" if symbol == "TWD=X" else "TW" if symbol.endswith((".TW", ".TWO")) else "US",
              "priceKind": "fx" if symbol == "TWD=X" else "total-return", "source": "market",
              "usage": "research-only", "sourceName": f"{metadata['source']} · research only / 僅供研究",
              "asOf": rows[-1][0], "rows": rows}
    return result, findings


def main():
    parser = argparse.ArgumentParser(description="Refresh original research sources without changing the desktop app.")
    parser.add_argument("--symbols", default="0050.TW,VTI,QQQ,TWD=X")
    parser.add_argument("--start", default="2015-01-01")
    parser.add_argument("--end", default=(date.today() - timedelta(days=1)).isoformat())
    parser.add_argument("--desktop-cache", type=Path)
    parser.add_argument("--cache-only", action="store_true")
    parser.add_argument("--output", type=Path, default=Path("data-private/research-market.json"))
    args = parser.parse_args()
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    if start >= end or end >= date.today() or start.year < 1990:
        raise ValueError("Use a completed historical period starting in 1990 or later.")
    symbols = [value.strip().upper() for value in args.symbols.split(",")]
    if len(symbols) > 13 or any(not re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=\-]{0,23}", symbol) for symbol in symbols):
        raise ValueError("Invalid symbol list; maximum 13 series including FX.")
    if args.cache_only and not args.desktop_cache:
        raise ValueError("--cache-only requires --desktop-cache")
    cache_root = Path("data-private/provider-cache").resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    series, findings = [], []
    for symbol in symbols:
        print(f"Reading {symbol}", file=sys.stderr)
        if args.cache_only:
            frame, metadata = read_cache(args.desktop_cache.resolve(), symbol)
        else:
            if args.desktop_cache and symbol == "0050.TW":
                source = args.desktop_cache.resolve() / "twse" / "0050"
                if source.is_dir():
                    target = cache_root / "cache" / "twse" / "0050"
                    target.mkdir(parents=True, exist_ok=True)
                    for path in source.glob("*.json"):
                        if re.fullmatch(r"\d{6}\.json|splits\.json|dividends\.json", path.name):
                            shutil.copy2(path, target / path.name)
            frame, metadata = refresh(symbol, args.start, args.end, cache_root)
        converted, audit = convert(symbol, frame, metadata, args.start, args.end)
        series.append(converted)
        findings.extend(audit)
    atomic_json(args.output, series)
    atomic_json(args.output.with_suffix(".audit.json"), findings)
    print(f"Saved {len(series)} research series; {len(findings)} audit flags. No public upload performed.")


if __name__ == "__main__":
    main()
