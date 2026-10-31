import { z } from 'zod';
import { isoDate, seriesSchema, type PriceSeries } from '../src/core/schema';
import { ApiError } from './security';

export type Rows = PriceSeries['rows'];
export type Action = {date: string; value: number};
export type Upstream = (url: URL) => Promise<string>;
const invalid = () => new ApiError(502, 'PROVIDER_DATA_INVALID');
const positive = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw invalid();
  return number;
};
export const dateString = (stamp: number) => new Date(stamp).toISOString().slice(0, 10);
const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

export function completedDate(symbol: string, now = Date.now()): string {
  if (symbol === 'USDTWD') return dateString(now);
  const taiwan = /\.TWO?$/.test(symbol);
  const formatter = new Intl.DateTimeFormat('en-CA', {timeZone: taiwan ? 'Asia/Taipei' : 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'});
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  if (Number(parts.hour) < (taiwan ? 17 : 18)) date.setUTCDate(date.getUTCDate() - 1);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
  return dateString(date.getTime());
}

export function mergeAdjusted(previous: Rows, fresh: Rows): Rows {
  const previousMap = new Map(previous);
  const overlap = fresh.filter(([date]) => previousMap.has(date));
  if (overlap.length < 3) throw invalid();
  const scale = overlap[0][1] / previousMap.get(overlap[0][0])!;
  if (overlap.some(([date, value]) => Math.abs(value / previousMap.get(date)! / scale - 1) > 0.000001)) throw invalid();
  const freshDates = new Set(fresh.map(([date]) => date));
  if (previous.some(([date]) => date >= fresh[0][0] && date <= fresh.at(-1)![0] && !freshDates.has(date))) throw invalid();
  const rows = new Map(previous.map(([date, value]) => [date, value * scale]));
  for (const [date, value] of fresh) rows.set(date, value);
  const normalize = fresh.at(-1)![0] < previous.at(-1)![0] ? 1 / scale : 1;
  return [...rows].sort(([first], [second]) => first.localeCompare(second)).map(([date, value]) => [date, value * normalize]);
}

function rocDate(input: string): string {
  const parts = /^(\d{2,4})\/(\d{2})\/(\d{2})$/.exec(input);
  if (!parts) throw invalid();
  const year = Number(parts[1]);
  return isoDate.parse(`${year < 1911 ? year + 1911 : year}-${parts[2]}-${parts[3]}`);
}

export function parseMonth(input: unknown, month: string): Rows {
  const payload = z.object({stat: z.literal('OK'), fields: z.tuple([z.literal('日期'), z.literal('收盤價')]), data: z.array(z.tuple([z.string(), z.string()]))}).parse(input);
  const rows: Rows = [];
  for (const [day, close] of payload.data) {
    if (day.trim() === '月平均收盤價' || ['--', '---', ''].includes(close.trim())) continue;
    const date = rocDate(day.trim());
    if (date.replaceAll('-', '').slice(0, 6) !== month) throw invalid();
    rows.push([date, positive(close.replaceAll(',', ''))]);
  }
  if (!rows.length || new Set(rows.map(row => row[0])).size !== rows.length) throw invalid();
  return rows.sort((first, second) => first[0].localeCompare(second[0]));
}

export function parseDividends(input: unknown): Action[] {
  const payload = z.object({ResultCode: z.literal(0), Data: z.object({Data: z.array(z.object({ISINCODE: z.literal('TW0000050004'), FUND_ID: z.literal('1066'), SHARE_DATE: z.string(), DIVIDEN_PER_UNIT: z.union([z.string(), z.number()])})).min(1)})}).parse(input);
  const actions = payload.Data.Data.map(row => ({date: isoDate.parse(row.SHARE_DATE.replaceAll('/', '-').slice(0, 10)), value: positive(row.DIVIDEN_PER_UNIT)})).sort((first, second) => first.date.localeCompare(second.date));
  if (actions[0].date !== '2005-05-19' || actions[0].value !== 1.85 || new Set(actions.map(action => action.date)).size !== actions.length) throw invalid();
  return actions;
}

export function parseSplits(input: unknown, end: string): Action[] {
  const payload = z.object({stat: z.literal('OK'), fields: z.array(z.string()), data: z.array(z.array(z.string()))}).parse(input);
  const needed = ['恢復買賣日期', 'ETF代號', '停止買賣前收盤價格', '恢復買賣參考價'];
  if (needed.some(field => !payload.fields.includes(field))) throw invalid();
  const actions: Action[] = [];
  for (const row of payload.data) {
    const item = Object.fromEntries(payload.fields.map((field, index) => [field, row[index]]));
    if (item['ETF代號'] !== '0050') continue;
    const date = rocDate(item['恢復買賣日期']);
    if (date !== '2025-06-18' || Math.abs(positive(item['停止買賣前收盤價格']) / 4 - positive(item['恢復買賣參考價'])) > 0.011) throw invalid();
    actions.push({date, value: 4});
  }
  if (new Set(actions.map(action => action.date)).size !== actions.length || (end >= '2025-06-18' && !actions.length)) throw invalid();
  return actions;
}

export function totalReturn(raw: Rows, dividends: Action[], splits: Action[]): Rows {
  if (raw.length < 3 || raw.some((row, index) => !Number.isFinite(row[1]) || row[1] <= 0 || (index > 0 && row[0] <= raw[index - 1][0]))) throw invalid();
  const dates = new Set(raw.map(row => row[0]));
  for (const actions of [dividends, splits]) {
    if (new Set(actions.map(action => action.date)).size !== actions.length) throw invalid();
    for (const action of actions) {
      positive(action.value);
      if (action.date >= raw[0][0] && action.date <= raw.at(-1)![0] && !dates.has(action.date)) throw invalid();
    }
  }
  const cash = new Map(dividends.map(action => [action.date, action.value]));
  const ratios = new Map(splits.map(action => [action.date, action.value]));
  let growth = 1;
  const result: Rows = raw.map(([date, close], index) => {
    if (cash.has(date) && ratios.has(date)) throw invalid();
    const factor = index === 0 ? 1 : (close * (ratios.get(date) ?? 1) + (cash.get(date) ?? 0)) / raw[index - 1][1];
    if (Math.abs(factor - 1) > 0.25) throw invalid();
    growth *= factor;
    return [date, growth];
  });
  const scale = raw.at(-1)![1] / growth;
  return result.map(([date, value]) => [date, value * scale]);
}

export function marketSeries(symbol: string, rows: Rows, sourceName: string, name = symbol): PriceSeries {
  const fx = symbol === 'USDTWD';
  const taiwan = /\.TWO?$/.test(symbol);
  return seriesSchema.parse({symbol, name: name.slice(0, 80), market: fx ? 'FX' : taiwan ? 'TW' : 'US', currency: fx || taiwan ? 'TWD' : 'USD', priceKind: fx ? 'fx' : 'total-return', source: 'market', usage: 'research-only', sourceName, asOf: rows.at(-1)?.[0], rows});
}

export function parseYahoo(input: unknown, symbol: string, start: string, end: string): PriceSeries {
  const payload = z.object({chart: z.object({error: z.unknown().nullish(), result: z.array(z.object({meta: z.object({symbol: z.string(), currency: z.string(), exchangeTimezoneName: z.string(), instrumentType: z.string(), longName: z.string().optional(), shortName: z.string().optional()}), timestamp: z.array(z.number().int()), indicators: z.object({quote: z.array(z.object({close: z.array(z.number().nullable())})), adjclose: z.array(z.object({adjclose: z.array(z.number().nullable())}))})})).nullable()})}).parse(input);
  const result = payload.chart.result?.[0];
  if (payload.chart.error || !result) throw new ApiError(404, 'DATA_UNAVAILABLE');
  const taiwan = /\.TWO?$/.test(symbol);
  if (result.meta.symbol !== symbol || result.meta.currency !== (taiwan ? 'TWD' : 'USD') || !['EQUITY', 'ETF', 'MUTUALFUND'].includes(result.meta.instrumentType)) throw invalid();
  const formatter = new Intl.DateTimeFormat('en-CA', {timeZone: result.meta.exchangeTimezoneName, year: 'numeric', month: '2-digit', day: '2-digit'});
  const adjusted = result.indicators.adjclose[0]?.adjclose;
  const closes = result.indicators.quote[0]?.close;
  if (!adjusted || adjusted.length !== result.timestamp.length || closes?.length !== adjusted.length) throw invalid();
  const rows: Rows = [];
  result.timestamp.forEach((stamp, index) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(stamp * 1000)).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (date < start || date > end || (taiwan && date >= '2019-01-01' && [0, 6].includes(weekday))) return;
    if (closes[index] === null && adjusted[index] === null) return;
    positive(closes[index]);
    rows.push([date, positive(adjusted[index])]);
  });
  return marketSeries(symbol, rows, 'Yahoo Finance · dividend & split adjusted', result.meta.longName ?? result.meta.shortName ?? symbol);
}

export async function yahoo(upstream: Upstream, symbol: string, start: string, end: string): Promise<PriceSeries> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.search = new URLSearchParams({period1: String(epoch(start) - 86400), period2: String(epoch(end) + 86400), interval: '1d', events: 'div,splits', includeAdjustedClose: 'true'}).toString();
  return parseYahoo(JSON.parse(await upstream(url)), symbol, start, end);
}

export function parseFred(text: string, start: string, end: string): PriceSeries {
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== 'observation_date,DEXTAUS') throw invalid();
  const rows: Rows = [];
  for (const line of lines) {
    const [date, value, extra] = line.split(',');
    if (extra !== undefined) throw invalid();
    isoDate.parse(date);
    if (date < start || date > end || ['', '.'].includes(value)) continue;
    const price = positive(value);
    if (rows.length && Math.abs(price / rows.at(-1)![1] - 1) > 0.1) throw invalid();
    rows.push([date, price]);
  }
  return marketSeries('USDTWD', rows, 'Federal Reserve / FRED DEXTAUS · TWD per USD');
}

export async function fred(upstream: Upstream, start: string, end: string): Promise<PriceSeries> {
  const url = new URL('https://fred.stlouisfed.org/graph/fredgraph.csv');
  url.search = new URLSearchParams({id: 'DEXTAUS', cosd: start, coed: end}).toString();
  return parseFred(await upstream(url), start, end);
}

export function parseFederalReserve(html: string, start: string, end: string): PriceSeries {
  if (!html.includes('Historical Rates for the New Taiwan Dollar') || !/Rates in New Taiwan dollars per U\.S\. dollar/.test(html)) throw invalid();
  const table = html.match(/<table\b[^>]*(?:title|summary)="[^"]*New Taiwan Dollar[^"]*"[^>]*>([\s\S]*?)<\/table>/i)?.[1]?.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/i, '');
  if (!table) throw invalid();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const lines = ['observation_date,DEXTAUS'];
  const matches = [...table.matchAll(/<tr\b[^>]*>\s*<th\b[^>]*>\s*(\d{1,2})-([A-Z]{3})-(\d{2})\s*<\/th>\s*<td\b[^>]*>\s*([^<]*?)\s*<\/td>\s*<\/tr>/g)];
  if (matches.length !== (table.match(/<tr\b/gi)?.length ?? 0)) throw invalid();
  for (const match of matches) {
    const month = months.indexOf(match[2]) + 1;
    if (!month) throw invalid();
    const date = `${2000 + Number(match[3])}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    lines.push(`${date},${match[4].trim() === 'ND' ? '.' : match[4].trim()}`);
  }
  const series = parseFred(lines.join('\n'), start, end);
  return {...series, sourceName: 'Federal Reserve H.10 · TWD per USD'};
}

export async function exchangeRates(upstream: Upstream, start: string, end: string): Promise<PriceSeries> {
  if (start < '2000-01-01') return fred(upstream, start, end);
  try {
    return parseFederalReserve(await upstream(new URL('https://www.federalreserve.gov/releases/h10/hist/dat00_ta.htm')), start, end);
  } catch (error) {
    if (!(error instanceof ApiError) || !['PROVIDER_UNAVAILABLE', 'DATA_UNAVAILABLE'].includes(error.code)) throw error;
    return fred(upstream, start, end);
  }
}
