import { mkdir, writeFile } from 'node:fs/promises';
import { seriesSchema } from '../src/core/schema';

const source = new URL(process.env.LICENSED_DATA_URL || 'https://invalid.example');
if (source.protocol !== 'https:' || source.username || source.password || source.hostname.endsWith('.example') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(source.hostname)) throw new Error('Configure an HTTPS dataset URL from the contracted provider or your own approved adapter.');
const response = await fetch(source, {signal:AbortSignal.timeout(60000), redirect:'error'});
if (!response.ok) throw new Error(`Licensed provider returned HTTP ${response.status}. No data was published.`);
const reader = response.body!.getReader();
const pieces: Uint8Array[] = [];
let size = 0;
while (true) {
  const part = await reader.read();
  if (part.done) break;
  size += part.value.byteLength;
  if (size > 32 * 1024 * 1024) {await reader.cancel();throw new Error('Dataset exceeds 32 MiB.');}
  pieces.push(part.value);
}
const content = Buffer.concat(pieces);
const value = JSON.parse(content.toString('utf8'));
if (!Array.isArray(value) || value.length > 64) throw new Error('Expected at most 64 standard PriceSeries records. A vendor-specific raw API response needs an adapter.');
const series = value.map(item => seriesSchema.parse(item));
if (series.some(item => item.source !== 'market' || item.usage !== 'redistribution-licensed')) throw new Error('Every series must have confirmed redistribution rights.');
await mkdir('data-private',{recursive:true});
await writeFile('data-private/licensed-market.json',JSON.stringify(series));
console.log(`Validated ${series.length} licensed series. Credentials and data content are not logged.`);
