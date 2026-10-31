import { writeFile } from 'node:fs/promises';
import { analyze, makeSnapshot } from '../src/core/engine';
import { defaultConfig } from '../src/core/demo';
import { type HistoryReply } from '../src/core/market';
import { isoDate, type PriceSeries } from '../src/core/schema';

const origin = new URL(process.env.TEST_API_ORIGIN || 'http://127.0.0.1:8788');
if (!['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('Local preview only');
const end = isoDate.parse(process.env.TEST_MARKET_END || new Date().toISOString().slice(0, 10));
const symbols = ['0050.TW', 'VTI', 'QQQ', 'USDTWD'];
const checks: Record<string, unknown>[] = [];
const loaded: PriceSeries[] = [];
const started = performance.now();
for (const symbol of symbols) {
  const before = performance.now();
  const start = symbol === 'USDTWD' ? '2015-12-25' : '2016-01-01';
  let complete = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    const response = await fetch(new URL(`/api/history/${symbol}/${start}/${end}`, origin), {signal: AbortSignal.timeout(40000)});
    const body = await response.json() as HistoryReply & {error?: string};
    if (!response.ok) throw new Error(`${symbol}: ${body.error}`);
    if ('series' in body) {
      loaded.push(body.series);
      checks.push({symbol, milliseconds: Math.round(performance.now() - before), pendingResponses: attempt, first: body.series.rows[0][0], last: body.series.rows.at(-1)![0], count: body.series.rows.length, source: body.series.sourceName});
      complete = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2100));
  }
  if (!complete) throw new Error(`Incomplete: ${symbol}`);
}
const config = {...structuredClone(defaultConfig), end, portfolios: symbols.filter(symbol => symbol !== 'USDTWD').map((symbol, index) => ({id: `test${index}`, name: symbol, assets: [{symbol, weight: 100}]}))};
const analysis = analyze(makeSnapshot(config, loaded));
const expectedEnd = loaded.filter(series => series.market !== 'FX').map(series => series.rows.at(-1)![0]).sort()[0];
if (analysis.end !== expectedEnd || Date.parse(end) - Date.parse(analysis.end) > 10 * 86400000) throw new Error(`Unexpected analysis end: ${analysis.end}`);
const report = {checkedAt: new Date().toISOString(), runtime: 'Local Wrangler HTTP and browser-equivalent engine; not a production test', requestedEnd: end, actualEnd: analysis.end, milliseconds: Math.round(performance.now() - started), checks};
console.log(JSON.stringify(report, null, 2));
await writeFile('acceptance/current-market-smoke.json', JSON.stringify(report, null, 2));
