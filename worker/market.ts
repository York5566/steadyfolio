import { z } from 'zod';
import { isoDate, seriesSchema, type PriceSeries } from '../src/core/schema';
import { marketSymbol, type HistoryReply } from '../src/core/market';
import { ApiError, boundedInteger } from './security';
import { completedDate, dateString, exchangeRates, marketSeries, mergeAdjusted, parseDividends, parseMonth, parseSplits, totalReturn, yahoo, type Rows } from './providers';

export interface MarketEnv {DB: D1Database; MARKET_LIMITER?: RateLimit; DAILY_MARKET_FETCH_LIMIT?: string; MARKET_FETCH_ENABLED?: string}
type Stored = {payload: string; updated_at: number; requested_start: string | null; requested_end: string | null};
const nowSeconds = () => Math.floor(Date.now() / 1000);
const response = (data: HistoryReply, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
const pending = (completed = 0, total = 0) => response({pending: true, completed, total}, 202);
const endsTooEarly = (series: PriceSeries, end: string) => Date.parse(end) - Date.parse(series.rows.at(-1)![0]) > 10 * 86400000;

export function historyRange(start: string, end: string, symbol = 'AAPL') {
  isoDate.parse(start); isoDate.parse(end);
  const latest = completedDate(symbol);
  if (start >= end || start > latest) throw new ApiError(400, 'INVALID_PERIOD');
  return {start, end: end < latest ? end : latest};
}

export async function upstreamText(url: URL): Promise<string> {
  let result: Response;
  try {result = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {Accept: 'application/json,text/csv,*/*', 'User-Agent': 'Steadyfolio/1.0'}});}
  catch (error) {console.warn('Market connection failed', url.hostname, error instanceof Error ? error.message : 'request failed'); throw new ApiError(502, 'PROVIDER_UNAVAILABLE');}
  if ([428, 429].includes(result.status)) {await result.body?.cancel(); throw new ApiError(503, 'PROVIDER_RATE_LIMITED');}
  if (!result.ok) {console.warn('Market response failed', url.hostname, result.status); await result.body?.cancel(); throw new ApiError(result.status === 404 ? 404 : 502, result.status === 404 ? 'DATA_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE');}
  if (!result.body) throw new ApiError(502, 'PROVIDER_DATA_INVALID');
  const reader = result.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0;
  let text = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4000000) {await reader.cancel(); throw new ApiError(502, 'PROVIDER_DATA_INVALID');}
    text += decoder.decode(value, {stream: true});
  }
  return text + decoder.decode();
}

async function budgetedFetch(env: MarketEnv, url: URL): Promise<string> {
  const day = dateString(Date.now());
  const reservation = await env.DB.prepare(`INSERT INTO market_budget(day,count) VALUES (?,1)
    ON CONFLICT(day) DO UPDATE SET count=count+1 WHERE count < ?`).bind(day, boundedInteger(env.DAILY_MARKET_FETCH_LIMIT, 800, 2000)).run();
  if (!reservation.meta.changes) throw new ApiError(503, 'MARKET_CAPACITY');
  return upstreamText(url);
}

async function saveRaw(env: MarketEnv, key: string, payload: string, expires: number) {
  await env.DB.prepare('INSERT INTO provider_cache(key,payload,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at').bind(key, payload, expires).run();
}

export function officialWindows(start: string, end: string, previous?: PriceSeries): {start: string; end: string}[] {
  if (!previous || previous.symbol !== '0050.TW' || previous.priceKind !== 'total-return' || previous.source !== 'market' ||
    !/^(TWSE closes \+ Yuanta dividends \+ TWSE splits|證交所收盤價＋元大配息＋證交所分割)/.test(previous.sourceName) || previous.rows.length < 5) return [{start, end}];
  const windows = [];
  if (start < previous.rows[0][0]) windows.push({start, end: previous.rows[4][0]});
  windows.push({start: previous.rows.at(-5)![0], end});
  if (windows.length === 2 && windows[0].end >= windows[1].start) return [{start, end}];
  return windows;
}

async function official0050(env: MarketEnv, start: string, end: string, previous?: PriceSeries): Promise<HistoryReply> {
  if (end < '2003-06-30') throw new ApiError(404, 'DATA_UNAVAILABLE');
  const windows = officialWindows(start, end, previous);
  const monthSet = new Set<string>();
  for (const window of windows) {
    for (let month = (window.start < '2003-06-30' ? '2003-06-30' : window.start).slice(0, 7); month <= window.end.slice(0, 7);) {
      monthSet.add(month.replace('-', ''));
      const next = new Date(`${month}-01T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      month = dateString(next.getTime()).slice(0, 7);
    }
  }
  const months = [...monthSet].sort();
  const now = nowSeconds();
  const latest = completedDate('0050.TW');
  const currentMonth = latest.replaceAll('-', '').slice(0, 6);
  const stored = await env.DB.prepare("SELECT key,payload FROM provider_cache WHERE key >= ? AND key <= ? AND expires_at > ?")
    .bind(`0050:${months[0]}`, `0050:${months.at(-1)}`, now).all<{key: string; payload: string}>();
  const cached = new Map<string, Rows>();
  for (const row of stored.results) {
    const month = row.key.slice(5);
    if (!monthSet.has(month)) continue;
    const payload = JSON.parse(row.payload) as Rows | {rows: Rows; through: string};
    const monthEnd = dateString(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)), 0));
    const required = end < monthEnd ? end : monthEnd;
    if (Array.isArray(payload)) {
      if (month < currentMonth) cached.set(month, payload);
    } else if (payload.through >= required) cached.set(month, payload.rows);
  }
  const missing = months.filter(month => !cached.has(month));
  for (const [index, month] of missing.slice(0, 2).entries()) {
    if (index > 0) await new Promise(resolve => setTimeout(resolve, 2100));
    const url = new URL('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_AVG');
    url.search = new URLSearchParams({date: `${month}01`, stockNo: '0050', response: 'json'}).toString();
    const rows = parseMonth(JSON.parse(await budgetedFetch(env, url)), month);
    await saveRaw(env, `0050:${month}`, JSON.stringify({rows, through: latest}), now + (month >= currentMonth ? 6 * 3600 : 30 * 86400));
    cached.set(month, rows);
  }
  if (missing.length > 2) return {pending: true, completed: cached.size, total: months.length};
  const storedActions = await env.DB.prepare("SELECT payload FROM provider_cache WHERE key = '0050:actions' AND expires_at > ?").bind(now).first<{payload: string}>();
  let actions: {dividends: ReturnType<typeof parseDividends>; splits: ReturnType<typeof parseSplits>};
  if (storedActions) actions = JSON.parse(storedActions.payload);
  else {
    const today = dateString(Date.now()).replaceAll('-', '');
    const dividendsUrl = new URL('https://api.yuantafunds.com/ectranslation/api/trans');
    dividendsUrl.search = new URLSearchParams({APIType: 'EC2API', AppName: 'FundWeb', PageName: '/myfund/dividend/history', Device: '4', DeviceId: crypto.randomUUID(), FuncId: 'FundDividend', FundId: '1066', FundType: 'ETF', SDate: '20030601', EDate: today}).toString();
    const dividends = parseDividends(JSON.parse(await budgetedFetch(env, dividendsUrl)));
    const splitsUrl = new URL('https://www.twse.com.tw/rwd/zh/split/TWTCAU');
    splitsUrl.search = new URLSearchParams({startDate: '20030630', endDate: today, response: 'json'}).toString();
    const splits = parseSplits(JSON.parse(await budgetedFetch(env, splitsUrl)), end);
    actions = {dividends, splits};
    await saveRaw(env, '0050:actions', JSON.stringify(actions), now + 6 * 3600);
  }
  let rows: Rows = [];
  const incremental = windows.length !== 1 || windows[0].start !== start || windows[0].end !== end;
  if (incremental) rows = previous!.rows;
  for (const window of windows) {
    const raw = months.filter(month => month >= window.start.slice(0, 7).replace('-', '') && month <= window.end.slice(0, 7).replace('-', ''))
      .flatMap(month => cached.get(month)!).filter(row => row[0] <= window.end);
    const fresh = totalReturn(raw, actions.dividends, actions.splits).filter(row => row[0] >= window.start);
    rows = rows.length ? mergeAdjusted(rows, fresh) : fresh;
  }
  rows = rows.filter(row => row[0] >= start && row[0] <= end);
  return {series: marketSeries('0050.TW', rows, 'TWSE closes + Yuanta dividends + TWSE splits', '元大台灣50')};
}

async function saveSeries(env: MarketEnv, series: PriceSeries, start: string, end: string) {
  const payload = JSON.stringify(series);
  if (new TextEncoder().encode(payload).byteLength > 524288) throw new ApiError(413, 'TOO_LARGE');
  const {rows, ...metadata} = series;
  const result = await env.DB.prepare(`INSERT INTO market_series(symbol,metadata,payload,updated_at,requested_start,requested_end)
    SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM market_series) < 128 OR EXISTS(SELECT 1 FROM market_series WHERE symbol=?)
    ON CONFLICT(symbol) DO UPDATE SET metadata=excluded.metadata,payload=excluded.payload,updated_at=excluded.updated_at,requested_start=excluded.requested_start,requested_end=excluded.requested_end`)
    .bind(series.symbol, JSON.stringify({...metadata, from: rows[0][0], to: rows.at(-1)![0], count: rows.length}), payload, nowSeconds(), start, end, series.symbol).run();
  if (!result.meta.changes) throw new ApiError(503, 'MARKET_CAPACITY');
}

export async function history(env: MarketEnv, symbolInput: string, startInput: string, endInput: string, ip: string): Promise<Response> {
  let symbol: string;
  try {symbol = marketSymbol(symbolInput);} catch {throw new ApiError(400, 'INVALID_SYMBOL');}
  const {start, end} = historyRange(startInput, endInput, symbol);
  const stored = await env.DB.prepare('SELECT payload,updated_at,requested_start,requested_end FROM market_series WHERE symbol=?').bind(symbol).first<Stored>();
  const now = nowSeconds();
  let fetchStart = start;
  let fetchEnd = end;
  if (stored) {
    const series = JSON.parse(stored.payload) as PriceSeries;
    const covers = (stored.requested_start ?? series.rows[0][0]) <= start && (stored.requested_end ?? series.rows.at(-1)![0]) >= end;
    const historical = end < dateString(Date.now() - 7 * 86400000);
    if (covers && !endsTooEarly(series, end) && (historical || now - stored.updated_at < 6 * 3600 || series.usage === 'redistribution-licensed')) return response({series});
    if (series.usage === 'redistribution-licensed') throw new ApiError(404, 'DATA_UNAVAILABLE');
    const previousStart = stored.requested_start ?? series.rows[0][0];
    const previousEnd = stored.requested_end ?? series.rows.at(-1)![0];
    fetchStart = previousStart < start ? previousStart : start;
    fetchEnd = previousEnd > end ? previousEnd : end;
  }
  if (env.MARKET_FETCH_ENABLED === 'false') throw new ApiError(503, 'DATA_UNAVAILABLE');
  if (!env.MARKET_LIMITER) throw new ApiError(503, 'PROTECTION_UNAVAILABLE');
  if (!(await env.MARKET_LIMITER.limit({key: ip})).success) throw new ApiError(429, 'RATE_LIMITED');
  const job = await env.DB.prepare('SELECT error,lease_until FROM market_jobs WHERE symbol=?').bind(symbol).first<{error: string | null; lease_until: number}>();
  if (job && job.lease_until > now) {
    if (job.error) throw new ApiError(503, job.error);
    return pending();
  }
  const lease = await env.DB.prepare(`INSERT INTO market_jobs(symbol,lease_until,touched_at)
    SELECT ?,?,? WHERE (SELECT count(*) FROM market_jobs) < 256 OR EXISTS(SELECT 1 FROM market_jobs WHERE symbol=?)
    ON CONFLICT(symbol) DO UPDATE SET lease_until=excluded.lease_until,error=NULL,touched_at=excluded.touched_at WHERE lease_until <= ?`)
    .bind(symbol, now + 45, now, symbol, now).run();
  if (!lease.meta.changes) throw new ApiError(503, 'MARKET_BUSY');
  try {
    const result = symbol === '0050.TW' ? await official0050(env, fetchStart, fetchEnd, stored ? JSON.parse(stored.payload) as PriceSeries : undefined) : {series: await (symbol === 'USDTWD' ? exchangeRates(url => budgetedFetch(env, url), fetchStart, fetchEnd) : yahoo(url => budgetedFetch(env, url), symbol, fetchStart, fetchEnd))};
    if ('series' in result) {
      seriesSchema.parse(result.series);
      if (endsTooEarly(result.series, end)) throw new ApiError(502, 'HISTORY_END_UNAVAILABLE');
      await saveSeries(env, result.series, fetchStart, fetchEnd);
    }
    await env.DB.prepare('UPDATE market_jobs SET lease_until=0,error=NULL WHERE symbol=?').bind(symbol).run();
    return response(result, 'pending' in result ? 202 : 200);
  } catch (error) {
    const problem = error instanceof ApiError ? error : new ApiError(502, error instanceof z.ZodError || error instanceof SyntaxError ? 'PROVIDER_DATA_INVALID' : 'PROVIDER_UNAVAILABLE');
    await env.DB.prepare('UPDATE market_jobs SET lease_until=?,error=? WHERE symbol=?').bind(nowSeconds() + 60, problem.code, symbol).run();
    throw problem;
  }
}
