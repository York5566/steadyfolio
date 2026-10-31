import { readFile } from 'node:fs/promises';
import { seriesSchema } from '../src/core/schema';

const file = process.argv[2];
const base = process.env.MARKET_API_ORIGIN;
const token = process.env.MARKET_ADMIN_TOKEN;
if (!file || !base || !token || token.length < 32) throw new Error('Usage: npm run data:import -- file.json; set MARKET_API_ORIGIN and MARKET_ADMIN_TOKEN in the environment.');
const origin = new URL(base);
const local = ['localhost','127.0.0.1'].includes(origin.hostname);
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (!local && origin.protocol !== 'https:')) throw new Error('Use an HTTPS API origin (HTTP allowed for loopback).');
const content = await readFile(file,'utf8');
if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('Input too large.');
const parsed = JSON.parse(content);
if (!Array.isArray(parsed) || parsed.length > 64) throw new Error('Expected up to 64 series.');
for (const item of parsed) {
  const series = seriesSchema.parse(item);
  if (!local && (series.usage !== 'redistribution-licensed' || process.env.DATA_RIGHTS_CONFIRMED !== 'true')) throw new Error('Public delivery needs confirmed storage, browser distribution, sharing, and export rights. Research data is for local preview only.');
  const response = await fetch(new URL('/api/admin/market',origin), {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({series,rightsConfirmed:true}),signal:AbortSignal.timeout(30000),redirect:'error'});
  if (!response.ok) throw new Error(`Import stopped: ${series.symbol}, HTTP ${response.status}. Prior successful symbols remain stored. Reruns are idempotent.`);
  console.log(`${series.symbol}: ${series.rows.length} rows imported.`);
  if (parsed.indexOf(item) < parsed.length - 1) await new Promise(resolve => setTimeout(resolve,13000));
}
