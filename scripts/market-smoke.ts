import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { history, type MarketEnv } from '../worker/market';
import type { HistoryReply } from '../src/core/market';
import type { PriceSeries } from '../src/core/schema';

const database = new DatabaseSync(':memory:');
for (const file of ['0001_initial.sql', '0002_automatic_market.sql']) database.exec(await readFile(`migrations/${file}`, 'utf8'));
const prepare = (sql: string) => {
  const query = database.prepare(sql);
  const bound = (values: unknown[]) => ({
    first: async () => query.get(...values as never[]) ?? null,
    all: async () => ({results: query.all(...values as never[])}),
    run: async () => ({meta: {changes: query.run(...values as never[]).changes}}),
  });
  return {...bound([]), bind: (...values: unknown[]) => bound(values)};
};
const env = {DB: {prepare}, MARKET_LIMITER: {limit: async () => ({success: true})}} as unknown as MarketEnv;
const checks: Record<string, unknown>[] = [];
const series: PriceSeries[] = [];
for (const symbol of ['0050.TW', '2330.TW', '6488.TWO', 'AAPL', 'USDTWD']) {
  let ready = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await history(env, symbol, '2025-05-01', '2025-07-31', 'smoke');
    const body = await response.json() as HistoryReply;
    if ('series' in body) {
      series.push(body.series);
      checks.push({symbol, rows: body.series.rows.length, from: body.series.rows[0][0], to: body.series.rows.at(-1)![0], source: body.series.sourceName, pendingResponses: attempt});
      console.log(`${symbol}: ${body.series.rows.length} rows, ${attempt} progress responses`);
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error(`Download did not finish: ${symbol}`);
}
const original = JSON.parse(await readFile('data-private/research-market.json', 'utf8').catch(() => '[]')) as PriceSeries[];
const reference = original.find(entry => entry.symbol === '0050.TW');
if (reference) {
  const actual = series.find(entry => entry.symbol === '0050.TW')!;
  const expected = new Map(reference.rows);
  const firstActual = actual.rows[0][1];
  const firstExpected = expected.get(actual.rows[0][0])!;
  const difference = Math.max(...actual.rows.map(([date, value]) => Math.abs(value / firstActual - expected.get(date)! / firstExpected)));
  if (!Number.isFinite(difference) || difference > 0.000001) throw new Error(`0050 differs from original desktop adjusted-price path: ${difference}`);
  checks.push({check: '0050 normalized total-return path matches desktop cache across split and dividend', maxAbsoluteDifference: difference});
}
const before = database.prepare('SELECT count FROM market_budget').get()?.count;
await history(env, 'AAPL', '2025-05-01', '2025-07-31', 'smoke');
if (database.prepare('SELECT count FROM market_budget').get()?.count !== before) throw new Error('Cache hit contacted upstream');
checks.push({check: 'cache reuse makes no upstream request', passed: true});
await writeFile('acceptance/automatic-market-smoke.json', JSON.stringify({checkedAt: new Date().toISOString(), runtime: 'Node SQLite in-memory, empty database, real provider HTTP; not a Cloudflare production test', checks}, null, 2));
database.close();
console.log('Live automatic-data checks passed. No provider price rows saved in the report.');
