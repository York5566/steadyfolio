"""Official 0050 closes/actions and Federal Reserve USD/TWD data.

Keep raw prices and corporate actions separate. Build a total-return series from
one consistent price source, rather than splicing unadjusted and adjusted prices.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from io import StringIO
import json
from pathlib import Path
import sys
import time
import uuid

import numpy as np
import pandas as pd

TWSE_CLOSE_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_AVG"
TWSE_SPLIT_URL = "https://www.twse.com.tw/rwd/zh/split/TWTCAU"
YUANTA_URL = "https://api.yuantafunds.com/ectranslation/api/trans"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
OFFICIAL_VERSION = "official-total-return-1"
INCEPTION = pd.Timestamp("2003-06-30")


def nontrading_rows(symbol, index):
    """TWSE/TPEX ended make-up Saturday trading from 2019; keep older sessions.

    This is a narrow verified calendar rule, not a complete holiday calendar.
    https://www.twse.com.tw/zh/about/company/history.html
    """
    taiwan = symbol.endswith((".TW", ".TWO")) or symbol == "^TWII"
    return (index >= pd.Timestamp("2019-01-01")) & (index.dayofweek >= 5) & taiwan


def roc_date(value):
    year, month, day = (int(x) for x in str(value).strip().split("/"))
    return pd.Timestamp(year + 1911 if year < 1911 else year, month, day)


def parse_month(payload, month):
    if payload.get("stat") != "OK" or payload.get("fields") != ["日期", "收盤價"]:
        raise ValueError(f"證交所 {month} 月收盤價回傳不完整：{payload.get('stat', '格式變更')}")
    rows = []
    for row in payload.get("data", []):
        if row[0].strip() == "月平均收盤價":
            continue
        dt = roc_date(row[0])
        if dt.strftime("%Y%m") != month:
            raise ValueError("證交所回傳日期不屬於要求月份。")
        if str(row[1]).strip() in ("--", "---", ""):
            continue
        value = float(str(row[1]).replace(",", ""))
        if not np.isfinite(value) or value <= 0:
            raise ValueError("證交所回傳無效價格。")
        rows.append((dt, value))
    result = pd.Series(dict(rows), dtype=float, name="Raw Close").sort_index()
    if result.empty or len(result) != len(rows):
        raise ValueError(f"證交所 {month} 月報價為空或有重複日期。")
    return result


def parse_dividends(payload):
    if payload.get("ResultCode") != 0:
        raise ValueError("元大歷史配息查詢失敗。")
    records = payload.get("Data", {}).get("Data")
    if not isinstance(records, list) or not records:
        raise ValueError("元大未回傳完整歷史配息，不會假設為零。")
    result = []
    seen = set()
    for row in records:
        if row.get("ISINCODE") != "TW0000050004" or row.get("FUND_ID") != "1066":
            raise ValueError("配息回傳標的與 0050 不符。")
        dt = pd.Timestamp(row["SHARE_DATE"]).normalize()
        cash = float(row["DIVIDEN_PER_UNIT"])
        if dt in seen or not np.isfinite(cash) or cash <= 0:
            raise ValueError("配息紀錄重複或金額無效。")
        seen.add(dt)
        result.append({"date": dt.date().isoformat(), "cash": cash, "pay_date": str(row["PAY_DATE"]).replace("/", "-")})
    result.sort(key=lambda r: r["date"])
    if result[0]["date"] != "2005-05-19" or result[0]["cash"] != 1.85:
        raise ValueError("0050 配息紀錄未涵蓋首次配息，停止含息計算。")
    return result


def parse_splits(payload):
    if payload.get("stat") != "OK":
        raise ValueError("證交所分割事件查詢失敗。")
    fields = payload.get("fields", [])
    needed = ["恢復買賣日期", "ETF代號", "停止買賣前收盤價格", "恢復買賣參考價"]
    if not all(k in fields for k in needed):
        raise ValueError("證交所分割事件格式變更。")
    result = []
    for row in payload.get("data", []):
        item = dict(zip(fields, row))
        if item["ETF代號"] != "0050":
            continue
        dt = roc_date(item["恢復買賣日期"]).date().isoformat()
        if dt != "2025-06-18":
            raise ValueError(f"0050 出現新的分割事件 {dt}，請核對確切比率後更新資料處理。")
        before = float(item["停止買賣前收盤價格"])
        reference = float(item["恢復買賣參考價"])
        if abs(before / 4 - reference) > .011:
            raise ValueError("0050 官方分割價格與已核對的 1 拆 4 不符。")
        result.append({"date": dt, "ratio": 4.0})
    if len({r["date"] for r in result}) != len(result):
        raise ValueError("分割事件重複。")
    return result


def total_return_prices(raw, dividends, splits):
    raw = raw.sort_index().astype(float)
    if raw.empty or raw.index.has_duplicates or not np.isfinite(raw).all() or (raw <= 0).any():
        raise ValueError("原始日收盤價不完整或無效。")
    cash = pd.Series(0.0, index=raw.index)
    ratio = pd.Series(1.0, index=raw.index)
    for events, field, target in ((dividends, "cash", cash), (splits, "ratio", ratio)):
        seen = set()
        for event in events:
            dt = pd.Timestamp(event["date"])
            if dt in seen:
                raise ValueError("重複的公司行動日期。")
            seen.add(dt)
            if raw.index[0] <= dt <= raw.index[-1]:
                if dt not in raw.index:
                    raise ValueError(f"{dt:%Y-%m-%d} 有配息／分割事件，卻缺少當日收盤價。")
                value = float(event[field])
                if not np.isfinite(value) or value <= 0:
                    raise ValueError("公司行動金額／比率無效。")
                target.at[dt] = value
    if ((cash > 0) & (ratio != 1)).any():
        raise ValueError("同日配息與分割需另行核對每單位金額口徑。")
    factors = (raw * ratio + cash) / raw.shift(1)
    factors.iloc[0] = 1.0
    growth = factors.cumprod()
    adjusted = growth / growth.iloc[-1] * raw.iloc[-1]
    future_splits = ratio.iloc[::-1].cumprod().iloc[::-1] / ratio
    close = raw / future_splits  # Split-adjusted, but excludes cash distributions.
    return pd.DataFrame({"Close": close, "Adj Close": adjusted, "Raw Close": raw,
                         "Dividends": cash, "Stock Splits": ratio.where(ratio != 1, 0.0)})


def get_json(session, url, params, check_cancel=lambda: None):
    error = None
    for attempt in range(3):
        check_cancel()
        try:
            response = session.get(url, params=params, timeout=20)
            if response.status_code in (428, 429):
                if attempt < 2:
                    for _ in range(30):
                        time.sleep(1)
                        check_cancel()
                    continue
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            error = exc
            if attempt < 2:
                time.sleep(attempt + 1)
    raise ValueError(f"官方來源連線失敗：{error}") from error


def download_0050(store, start, end, session, progress, check_cancel, refresh=False):
    from .data import atomic_json
    end = min(pd.Timestamp(end), pd.Timestamp(date.today()))
    if end < INCEPTION:
        raise ValueError("0050 於 2003-06-30 上市，之前沒有可交易價格。")
    folder = store.root / "cache" / "twse" / "0050"
    folder.mkdir(parents=True, exist_ok=True)
    months = pd.period_range(INCEPTION, end, freq="M")
    frames = []
    for i, month in enumerate(months):
        check_cancel()
        key = month.strftime("%Y%m")
        path = folder / f"{key}.json"
        progress(f"0050 官方歷史收盤價 {i+1}/{len(months)} · {month}")
        if path.exists() and month < pd.Period(date.today(), freq="M") and not refresh:
            payload = json.loads(path.read_text(encoding="utf-8"))
        else:
            payload = get_json(session, TWSE_CLOSE_URL, {"date": key + "01", "stockNo": "0050", "response": "json"}, check_cancel)
            parse_month(payload, key)
            atomic_json(path, payload)
            time.sleep(2)
        frames.append(parse_month(payload, key))
    raw = pd.concat(frames).loc[:end]
    if raw.index[0] != INCEPTION:
        raise ValueError("0050 官方收盤價未涵蓋上市首日。")
    check_cancel()
    progress("核對 0050 歷年配息與分割 …")
    params = {"APIType": "EC2API", "AppName": "FundWeb", "PageName": "/myfund/dividend/history", "Device": "4",
              "DeviceId": str(uuid.uuid4()), "FuncId": "FundDividend", "FundId": "1066", "FundType": "ETF",
              "SDate": "20030601", "EDate": date.today().strftime("%Y%m%d")}
    div_payload = get_json(session, YUANTA_URL, params)
    reference = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / "assets" / "reference" / "0050_splits.json"
    split_payload = None
    for path in (folder / "splits.json", reference):
        if path.exists():
            snapshot = json.loads(path.read_text(encoding="utf-8"))
            if snapshot.get("endDate", "") >= raw.index[-1].strftime("%Y%m%d"):
                split_payload = snapshot
                break
    if split_payload is None:
        split_payload = get_json(session, TWSE_SPLIT_URL, {"startDate": "20030630", "endDate": date.today().strftime("%Y%m%d"), "response": "json"}, check_cancel)
    dividends = parse_dividends(div_payload)
    splits = parse_splits(split_payload)
    if end >= pd.Timestamp("2025-06-18") and not splits:
        raise ValueError("官方分割資料未包含 2025-06-18 的 1 拆 4。")
    frame = total_return_prices(raw, dividends, splits)
    jumps = frame["Adj Close"].pct_change(fill_method=None)
    if (jumps.abs() > .25).any():
        dt = jumps.abs().idxmax()
        raise ValueError(f"0050 重建後 {dt:%Y-%m-%d} 仍有 {jumps.at[dt]:+.1%} 異常跳動，停止替換快取。")
    atomic_json(folder / "dividends.json", div_payload)
    atomic_json(folder / "splits.json", split_payload)
    return frame, {"currency": "TWD", "source": "證交所收盤價＋元大配息＋證交所分割",
        "data_version": OFFICIAL_VERSION, "price_kind": "both", "requested_start": start,
        "requested_end": end.date().isoformat(), "dividends": dividends, "splits": splits,
        "split_verified_through": split_payload["endDate"],
        "source_urls": [TWSE_CLOSE_URL, "https://www.yuantafunds.com/myfund/dividend/history?fundid=1066",
                        "https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other"],
        "method": "除息日按當日收盤價再投入；Close 僅調整分割；Adj Close 為現金股息總報酬序列。未計股息稅與發放日等待。",
        "quality_notes": ["0050 已由官方原始收盤價重建全段含息走勢，取代舊 Yahoo 2014 年錯誤；2003、2004 年無配息。"]}


def download_fx(start, end, session):
    response = session.get(FRED_URL, params={"id": "DEXTAUS"}, timeout=25)
    response.raise_for_status()
    frame = pd.read_csv(StringIO(response.text), index_col="observation_date", parse_dates=True)
    values = pd.to_numeric(frame["DEXTAUS"], errors="coerce").dropna().loc[start:end]
    if values.empty or values.index.has_duplicates or not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError("聯準會匯率資料無效。")
    if (values.pct_change(fill_method=None).abs() > .1).any():
        raise ValueError("聯準會匯率仍有超過 10% 的單日跳動，請核對來源。")
    return pd.DataFrame({"Close": values, "Adj Close": values}), {
        "currency": "TWD", "source": "Federal Reserve / FRED DEXTAUS", "data_version": OFFICIAL_VERSION,
        "requested_start": start, "requested_end": min(end, date.today().isoformat()), "price_kind": "both",
        "source_urls": ["https://fred.stlouisfed.org/series/DEXTAUS"],
        "method": "1 美元兌新台幣；紐約中午買入匯率，非台灣銀行間收盤匯率；發布有時間落差。",
        "quality_notes": ["USD/TWD 全段改用聯準會 DEXTAUS，取代 Yahoo 2011、2014 年底的錯誤報價；休市／未發布日不造值。"]}


def audit_prices(symbol, frame, column="Adj Close"):
    """Flag observations for review, not as proof that a real market move is wrong."""
    records = []
    values = frame[column].dropna()
    changes = values.pct_change(fill_method=None)
    gaps = values.index.to_series().diff().dt.days
    limit = .1 if symbol == "TWD=X" else .2
    for dt, value in changes[(changes.abs() > limit) & (gaps <= 7)].items():
        detail = f"{column} 相鄰報價變化 {value:+.2%}；可能是真實行情、除權或來源錯誤，未自動改價。"
        if symbol == "2308.TW" and str(dt.date()) in ("2000-07-14", "2000-07-17"):
            detail += " 已對照證交所：2000-07-13/14/15 原始收盤為 144/147.5/118 元；Yahoo 在 7/14 的調整疑似提前，完整除權息因素尚待核對，該段不可直接當成真實日報酬。"
        records.append({"symbol": symbol, "date": str(dt.date()), "kind": "大幅價格變動待核對", "change": float(value), "detail": detail})
    if column == "Adj Close" and {"Close", "Adj Close"} <= set(frame):
        factor = (frame["Adj Close"] / frame["Close"]).pct_change(fill_method=None)
        for dt, value in factor[factor.abs() > .25].items():
            records.append({"symbol": symbol, "date": str(dt.date()), "kind": "還原倍率變動待核對", "change": float(value),
                            "detail": "還原倍率變化超過 25%，需核對配息、除權或拆併股；未自動改價。"})
    return records
