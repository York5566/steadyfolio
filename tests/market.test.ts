import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { marketSymbol } from '../src/core/market';
import { history, historyRange, officialWindows, upstreamText, type MarketEnv } from '../worker/market';
import { completedDate, exchangeRates, marketSeries, mergeAdjusted, parseDividends, parseFederalReserve, parseFred, parseMonth, parseSplits, parseYahoo, totalReturn } from '../worker/providers';
import { ApiError } from '../worker/security';

function yahooPayload(symbol = 'AAPL', currency = 'USD') {
  return {chart: {error: null, result: [{meta: {symbol, currency, exchangeTimezoneName: 'America/New_York', instrumentType: 'EQUITY'}, timestamp: [1735828200, 1735914600, 1736173800], indicators: {quote: [{close: [100, 102, 104]}], adjclose: [{adjclose: [50, 51, 52]}]}}]}};
}
function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_initial.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0002_automatic_market.sql', 'utf8'));
  const prepare = (sql: string) => {
    const query = sqlite.prepare(sql);
    const bound = (args: unknown[]) => ({
      first: async () => query.get(...args as never[]) ?? null,
      all: async () => ({results: query.all(...args as never[])}),
      run: async () => ({meta: {changes: query.run(...args as never[]).changes}}),
    });
    return {...bound([]), bind: (...args: unknown[]) => bound(args)};
  };
  const env = {DB: {prepare}, MARKET_LIMITER: {limit: vi.fn().mockResolvedValue({success: true})}} as unknown as MarketEnv;
  return {env, sqlite};
}

afterEach(() => vi.unstubAllGlobals());
describe('desktop-equivalent price conventions', () => {
  it('normalizes Taiwan symbols and rejects URLs and unsupported markets', () => {
    expect(marketSymbol('0050')).toBe('0050.TW');
    expect(marketSymbol(' 6488.two ')).toBe('6488.TWO');
    expect(marketSymbol('brk-b')).toBe('BRK-B');
    for (const input of ['https://evil.org', '../AAPL', 'DEMO-TW', '0700.HK', 'AAPL?url=bad']) expect(() => marketSymbol(input)).toThrow('INVALID_SYMBOL');
  });
  it('uses adjusted prices, validates currency and never substitutes raw closes', () => {
    expect(parseYahoo(yahooPayload(), 'AAPL', '2025-01-01', '2025-01-10').rows.map(row => row[1])).toEqual([50, 51, 52]);
    expect(() => parseYahoo(yahooPayload('AAPL', 'EUR'), 'AAPL', '2025-01-01', '2025-01-10')).toThrow();
    const missing = yahooPayload();
    (missing.chart.result[0].indicators as {adjclose?: unknown}).adjclose = undefined;
    expect(() => parseYahoo(missing, 'AAPL', '2025-01-01', '2025-01-10')).toThrow();
  });
  it('uses the exchange date and removes Taiwan weekend artifacts after 2019', () => {
    const payload = yahooPayload('2330.TW', 'TWD');
    payload.chart.result[0].meta.exchangeTimezoneName = 'Asia/Taipei';
    payload.chart.result[0].timestamp = ['2025-01-01T16:30:00Z', '2025-01-02T16:30:00Z', '2025-01-05T16:30:00Z', '2025-01-03T16:30:00Z'].map(date => Date.parse(date) / 1000);
    payload.chart.result[0].indicators.quote[0].close.push(100);
    payload.chart.result[0].indicators.adjclose[0].adjclose.push(50);
    expect(parseYahoo(payload, '2330.TW', '2025-01-01', '2025-01-10').rows).toHaveLength(3);
  });
  it('reconstructs a 1-for-4 split and cash reinvestment without a false 75% loss', () => {
    const rows = totalReturn([['2025-06-17', 200], ['2025-06-18', 50], ['2025-06-19', 49], ['2025-06-20', 50]], [{date: '2025-06-19', value: 1}], [{date: '2025-06-18', value: 4}]);
    expect(rows.map(row => row[1])).toEqual([49, 49, 49, 50]);
    expect(() => totalReturn([['2025-06-17', 200], ['2025-06-18', 50], ['2025-06-19', 50]], [], [])).toThrow();
    expect(() => totalReturn([['2025-06-17', 200], ['2025-06-19', 50], ['2025-06-20', 50]], [], [{date: '2025-06-18', value: 4}])).toThrow();
  });
  it('rejects incomplete dividends, unknown split ratios and mismatched monthly dates', () => {
    expect(() => parseDividends({ResultCode: 0, Data: {Data: []}})).toThrow();
    const split = {stat: 'OK', fields: ['恢復買賣日期', 'ETF代號', '停止買賣前收盤價格', '恢復買賣參考價'], data: [['114/06/18', '0050', '188.65', '47.16']]};
    expect(parseSplits(split, '2025-07-01')).toEqual([{date: '2025-06-18', value: 4}]);
    split.data[0][0] = '115/06/18';
    expect(() => parseSplits(split, '2026-07-01')).toThrow();
    expect(() => parseMonth({stat: 'OK', fields: ['日期', '收盤價'], data: [['114/01/02', '190']]}, '202502')).toThrow();
  });
  it('keeps missing FRED observations missing and checks the TWD-per-USD convention', () => {
    const series = parseFred('observation_date,DEXTAUS\n2025-01-01,.\n2025-01-02,32.8\n2025-01-03,32.9\n2025-01-06,32.7', '2025-01-01', '2025-01-07');
    expect(series.rows).toHaveLength(3);
    expect(series).toMatchObject({symbol: 'USDTWD', currency: 'TWD', priceKind: 'fx'});
    expect(() => parseFred('observation_date,DEXTAUS\n2025-01-02,32\n2025-01-03,2\n2025-01-06,32', '2025-01-01', '2025-01-07')).toThrow();
  });
});

describe('automatic downloads and abuse bounds', () => {
  it('fetches a new symbol, reuses cache and refetches an expanded requested range', async () => {
    const {env, sqlite} = environment();
    const upstream = vi.fn().mockImplementation(async () => Response.json(yahooPayload()));
    vi.stubGlobal('fetch', upstream);
    const first = await history(env, 'AAPL', '2025-01-01', '2025-01-10', 'ip');
    expect(first.status).toBe(200);
    expect((await first.json() as {series: {usage: string}}).series.usage).toBe('research-only');
    expect((await history(env, 'AAPL', '2025-01-02', '2025-01-09', 'ip')).status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    await history(env, 'AAPL', '2024-01-01', '2025-01-10', 'ip');
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[0][0])).toContain('query1.finance.yahoo.com/v8/finance/chart/AAPL');
    expect(sqlite.prepare('SELECT count FROM market_budget').get()?.count).toBe(2);
    sqlite.close();
  });
  it('globally bounds upstream requests while cached prices remain usable', async () => {
    const {env, sqlite} = environment();env.DAILY_MARKET_FETCH_LIMIT = '1';
    const upstream = vi.fn().mockImplementation(async () => Response.json(yahooPayload()));vi.stubGlobal('fetch', upstream);
    await history(env, 'AAPL', '2025-01-01', '2025-01-10', 'ip');
    await expect(history(env, 'MSFT', '2025-01-01', '2025-01-10', 'other-ip')).rejects.toMatchObject({code: 'MARKET_CAPACITY'});
    expect((await history(env, 'AAPL', '2025-01-01', '2025-01-10', 'ip')).status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();sqlite.close();
  });
  it('honors source throttling, caches the failure briefly and does not return synthetic data', async () => {
    const {env, sqlite} = environment();
    const upstream = vi.fn().mockResolvedValue(new Response('slow down', {status: 429}));vi.stubGlobal('fetch', upstream);
    for (let attempt = 0; attempt < 2; attempt++) await expect(history(env, 'AAPL', '2025-01-01', '2025-01-10', 'ip')).rejects.toMatchObject({code: 'PROVIDER_RATE_LIMITED'});
    expect(upstream).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT count(*) AS total FROM market_series').get()?.total).toBe(0);sqlite.close();
  });
  it('does not start duplicate work while the symbol lease is active', async () => {
    const {env, sqlite} = environment();
    sqlite.prepare('INSERT INTO market_jobs VALUES (?,?,NULL,?)').run('AAPL', Math.floor(Date.now()/1000)+45, Math.floor(Date.now()/1000));
    const upstream = vi.fn();vi.stubGlobal('fetch', upstream);
    expect((await history(env, 'AAPL', '2025-01-01', '2025-01-10', 'ip')).status).toBe(202);
    expect(upstream).not.toHaveBeenCalled();sqlite.close();
  });
  it('caps streamed provider responses and refuses redirects', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('x'.repeat(4000001)));vi.stubGlobal('fetch', upstream);
    await expect(upstreamText(new URL('https://fred.stlouisfed.org/graph/fredgraph.csv'))).rejects.toMatchObject({code: 'PROVIDER_DATA_INVALID'});
    expect(upstream.mock.calls[0][1].redirect).toBe('manual');
    upstream.mockResolvedValue(new Response(null, {status: 302, headers: {Location: 'http://127.0.0.1/private'}}));
    await expect(upstreamText(new URL('https://fred.stlouisfed.org/graph/fredgraph.csv'))).rejects.toMatchObject({code: 'PROVIDER_UNAVAILABLE'});
  });
  it('validates calendars and clamps future prices to completed dates', () => {
    expect(() => historyRange('2025-02-30', '2025-03-10')).toThrow();
    expect(() => historyRange('2025-01-02', '2025-01-01')).toThrow();
    expect(historyRange('2020-01-01', '2099-01-01').end).toBe(completedDate('AAPL'));
  });
});

const fedHtml = `<h5>Historical Rates for the New Taiwan Dollar</h5><p>(Rates in New Taiwan dollars per U.S. dollar)</p>
<table title="Historical Rates for the New Taiwan Dollar"><thead><th>Date</th><th>Rate</th></thead>
<tr><th>2-JAN-25</th><td>32.8000</td></tr><tr><th>3-JAN-25</th><td>32.9000</td></tr>
<tr><th>6-JAN-25</th><td>32.7000</td></tr><tr><th>7-JAN-25</th><td>ND</td></tr></table>`;

describe('incremental history and current-date regressions', () => {
  it('uses each market close, not a blanket UTC yesterday cutoff', () => {
    const beforeTaiwanClose = Date.parse('2026-10-20T08:59:00Z');
    const afterTaiwanClose = Date.parse('2026-10-20T09:00:00Z');
    expect(completedDate('0050.TW', beforeTaiwanClose)).toBe('2026-10-19');
    expect(completedDate('0050.TW', afterTaiwanClose)).toBe('2026-10-20');
    expect(completedDate('AAPL', afterTaiwanClose)).toBe('2026-10-19');
    expect(completedDate('AAPL', Date.parse('2026-10-20T22:00:00Z'))).toBe('2026-10-20');
    expect(completedDate('6488.TWO', Date.parse('2026-10-24T12:00:00Z'))).toBe('2026-10-23');
  });
  it('extends verified history with overlap months rather than downloading every year again', () => {
    const rows: [string, number][] = [['2015-01-05', 10], ['2016-01-04', 20], ['2025-12-24', 30], ['2025-12-25', 31], ['2025-12-26', 32], ['2025-12-29', 33], ['2025-12-30', 34], ['2025-12-31', 35]];
    const previous = marketSeries('0050.TW', rows, 'TWSE closes + Yuanta dividends + TWSE splits');
    expect(officialWindows('2015-01-05', '2026-10-20', previous)).toEqual([{start: '2025-12-25', end: '2026-10-20'}]);
    expect(officialWindows('2014-01-01', '2026-10-20', previous)).toEqual([{start: '2014-01-01', end: '2026-10-20'}]);
    expect(officialWindows('2015-01-05', '2026-10-20', {...previous, sourceName: 'Unknown provider'})).toEqual([{start: '2015-01-05', end: '2026-10-20'}]);
  });
  it('stitches on verified return ratios, including a split and dividend, without artificial losses', () => {
    const before: [string, number][] = [['2025-06-12', 196], ['2025-06-13', 198], ['2025-06-16', 199], ['2025-06-17', 200]];
    const after: [string, number][] = [...before.slice(1), ['2025-06-18', 50], ['2025-06-19', 49], ['2025-06-20', 50]];
    const actions = [{date: '2025-06-19', value: 1}];
    const splits = [{date: '2025-06-18', value: 4}];
    const merged = mergeAdjusted(totalReturn(before, [], []), totalReturn(after, actions, splits));
    const expected = totalReturn([before[0], ...after], actions, splits);
    for (const [index, row] of merged.entries()) expect(row[1]).toBeCloseTo(expected[index][1], 10);
    expect(() => mergeAdjusted(before, [['2025-06-13', 99], ['2025-06-16', 99.5], ['2025-06-17', 99]])).toThrow();
    expect(() => mergeAdjusted(before, [['2025-06-17', 200], ['2025-06-18', 201], ['2025-06-19', 202]])).toThrow();
  });
  it('parses the direct Federal Reserve feed with the same FX convention and leaves ND missing', () => {
    const result = parseFederalReserve(fedHtml, '2025-01-01', '2025-01-10');
    expect(result.rows).toEqual([['2025-01-02', 32.8], ['2025-01-03', 32.9], ['2025-01-06', 32.7]]);
    expect(result.sourceName).toContain('Federal Reserve H.10');
    expect(() => parseFederalReserve(fedHtml.replace('New Taiwan dollars per U.S. dollar', 'U.S. dollars per New Taiwan dollar'), '2025-01-01', '2025-01-10')).toThrow();
    expect(() => parseFederalReserve(fedHtml.replace('32.7000', '2.0000'), '2025-01-01', '2025-01-10')).toThrow();
  });
  it('tries the responsive official FX feed first and falls back only on connection failures', async () => {
    const upstream = vi.fn().mockResolvedValue(fedHtml);
    await exchangeRates(upstream, '2025-01-01', '2025-01-10');
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0].hostname).toBe('www.federalreserve.gov');
    upstream.mockReset().mockRejectedValueOnce(new ApiError(502, 'PROVIDER_UNAVAILABLE')).mockResolvedValue('observation_date,DEXTAUS\n2025-01-02,32.8\n2025-01-03,32.9\n2025-01-06,32.7');
    expect((await exchangeRates(upstream, '2025-01-01', '2025-01-10')).rows).toHaveLength(3);
    expect(upstream.mock.calls[1][0].hostname).toBe('fred.stlouisfed.org');
    upstream.mockReset().mockRejectedValue(new ApiError(503, 'MARKET_CAPACITY'));
    await expect(exchangeRates(upstream, '2025-01-01', '2025-01-10')).rejects.toMatchObject({code: 'MARKET_CAPACITY'});
    expect(upstream).toHaveBeenCalledOnce();
  });
  it('does not mark a response ending in 2025 as covering a requested 2026 end', async () => {
    const {env, sqlite} = environment();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(yahooPayload())));
    await expect(history(env, 'AAPL', '2025-01-01', '2026-10-20', 'ip')).rejects.toMatchObject({code: 'HISTORY_END_UNAVAILABLE'});
    expect(sqlite.prepare('SELECT count(*) AS total FROM market_series').get()?.total).toBe(0);
    sqlite.close();
  });
  it('updates an existing ten-year 0050 series using just two months and reuses the result', async () => {
    const {env, sqlite} = environment();
    const december: [string, number][] = [['2025-12-24', 40], ['2025-12-25', 41], ['2025-12-26', 42], ['2025-12-29', 43], ['2025-12-30', 44], ['2025-12-31', 45]];
    const january: [string, number][] = [['2026-01-02', 46], ['2026-01-05', 47], ['2026-01-06', 48]];
    const previous = marketSeries('0050.TW', [['2015-01-05', 10], ['2015-01-06', 11], ...december], '證交所收盤價＋元大配息＋證交所分割 · research only / 僅供研究');
    sqlite.prepare('INSERT INTO market_series VALUES (?,?,?,?,?,?)').run('0050.TW', '{}', JSON.stringify(previous), 0, '2015-01-05', '2025-12-31');
    sqlite.prepare('INSERT INTO provider_cache VALUES (?,?,?)').run('0050:actions', JSON.stringify({dividends: [{date: '2005-05-19', value: 1.85}], splits: [{date: '2025-06-18', value: 4}]}), Math.floor(Date.now()/1000) + 3600);
    const upstream = vi.fn().mockImplementation(async (url: URL) => {
      const rows = url.searchParams.get('date') === '20251201' ? december : january;
      return Response.json({stat: 'OK', fields: ['日期', '收盤價'], data: rows.map(([date, value]) => [`${Number(date.slice(0, 4)) - 1911}/${date.slice(5).replace('-', '/')}`, String(value)])});
    });
    vi.stubGlobal('fetch', upstream);
    const result = await history(env, '0050.TW', '2016-01-01', '2026-01-10', 'ip');
    const body = await result.json() as {series: {rows: [string, number][]}};
    expect(result.status).toBe(200);
    expect(body.series.rows.at(-1)).toEqual(['2026-01-06', 48]);
    expect(body.series.rows[0][0]).toBe('2015-01-05');
    expect(body.series.rows[0][1]).toBeCloseTo(10, 10);
    expect(upstream.mock.calls.map(call => call[0].searchParams.get('date'))).toEqual(['20251201', '20260101']);
    await history(env, '0050.TW', '2016-01-01', '2026-01-10', 'ip');
    expect(upstream).toHaveBeenCalledTimes(2);
    sqlite.close();
  });
});
