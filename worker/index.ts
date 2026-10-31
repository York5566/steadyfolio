import { z } from 'zod';
import { LIMITS, seriesSchema, snapshotSchema } from '../src/core/schema';
import { ApiError, boundedInteger, isLocal, randomToken, readJson, securityHeaders, sha256 } from './security';
import { history, type MarketEnv } from './market';

export interface Env extends MarketEnv {
  ASSETS: Fetcher; DB: D1Database; READ_LIMITER: RateLimit; WRITE_LIMITER: RateLimit;
  ENVIRONMENT: string; PUBLIC_ORIGIN: string; ALLOWED_ORIGINS: string; SHARING_ENABLED: string;
  TURNSTILE_SITE_KEY: string; TURNSTILE_SECRET_KEY?: string; ADMIN_TOKEN?: string;
  MAX_SHARE_BYTES?: string; DAILY_SHARE_LIMIT?: string; TOTAL_SHARE_BYTES_LIMIT?: string;
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers}});
const payloadSchema = z.object({snapshot: snapshotSchema, token: z.string().min(1).max(2048)}).strict();
const importSchema = z.object({series: seriesSchema, rightsConfirmed: z.literal(true)}).strict();

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return origin && allowed.includes(origin) ? origin : null;
}

async function verifyTurnstile(request: Request, env: Env, token: string, origin: string) {
  if (isLocal(request, env.ENVIRONMENT) && token === 'local-development') return;
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY || /^[123]x000/.test(env.TURNSTILE_SITE_KEY)) throw new ApiError(503, 'SHARING_UNAVAILABLE');
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: request.headers.get('CF-Connecting-IP')}),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new ApiError(503, 'VERIFICATION_UNAVAILABLE');
  const result = await response.json() as {success?: boolean; hostname?: string; action?: string};
  if (!result.success || result.hostname !== new URL(origin).hostname || result.action !== 'share') throw new ApiError(403, 'VERIFICATION_FAILED');
}

async function publicMarket(request: Request, env: Env, context: ExecutionContext, symbol?: string): Promise<Response> {
  const cache = (caches as unknown as {default: Cache}).default;
  const key = new Request(new URL(`/api/market${symbol ? `/${symbol}` : ''}`, request.url));
  const cached = await cache.match(key);
  if (cached) return cached;
  let response: Response;
  if (symbol) {
    const entry = await env.DB.prepare('SELECT payload FROM market_series WHERE symbol = ?').bind(symbol).first<{payload: string}>();
    if (!entry) throw new ApiError(404, 'DATA_UNAVAILABLE');
    response = new Response(entry.payload, {headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=900'}});
  } else {
    const result = await env.DB.prepare('SELECT metadata FROM market_series ORDER BY symbol LIMIT 64').all<{metadata: string}>();
    response = json({series: result.results.map(row => JSON.parse(row.metadata))}, 200, {'Cache-Control': 'public, max-age=900'});
  }
  context.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function route(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.search) throw new ApiError(400, 'QUERY_NOT_SUPPORTED');
  const path = url.pathname;
  const origin = allowedOrigin(request, env);
  if (request.headers.has('origin') && !origin) throw new ApiError(403, 'ORIGIN_DENIED');
  if (request.method === 'OPTIONS') {
    if (!origin) throw new ApiError(403, 'ORIGIN_DENIED');
    return new Response(null, {status: 204, headers: {'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600'}});
  }
  const local = isLocal(request, env.ENVIRONMENT);
  const limiter = request.method === 'GET' ? env.READ_LIMITER : env.WRITE_LIMITER;
  if (!limiter) throw new ApiError(503, 'PROTECTION_UNAVAILABLE');
  const ip = request.headers.get('CF-Connecting-IP') ?? (local ? 'local' : 'unknown');
  if (!(await limiter.limit({key: ip})).success) throw new ApiError(429, 'RATE_LIMITED');
  if (path === '/api/config' && request.method === 'GET') return json({sharingEnabled: env.SHARING_ENABLED === 'true' && (local || Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY && !/^[123]x000/.test(env.TURNSTILE_SITE_KEY))), siteKey: env.TURNSTILE_SITE_KEY, localDevelopment: local});
  if (path === '/api/market' && request.method === 'GET') return publicMarket(request, env, context);
  const historyMatch = /^\/api\/history\/([A-Z0-9][A-Z0-9.\-]{0,23})\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (historyMatch && request.method === 'GET') return history(env, historyMatch[1], historyMatch[2], historyMatch[3], ip);
  const marketMatch = /^\/api\/market\/([A-Z0-9^][A-Z0-9.^=\-]{0,23})$/.exec(path);
  if (marketMatch && request.method === 'GET') return publicMarket(request, env, context, marketMatch[1]);
  if (path === '/api/admin/market' && request.method === 'POST') {
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new ApiError(503, 'ADMIN_UNAVAILABLE');
    const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (supplied.length > 512 || await sha256(supplied) !== await sha256(env.ADMIN_TOKEN)) throw new ApiError(401, 'UNAUTHORIZED');
    const {series} = importSchema.parse(await readJson(request, LIMITS.shareBytes));
    if (series.source !== 'market') throw new ApiError(400, 'INVALID_MARKET_SOURCE');
    if (!local && series.usage !== 'redistribution-licensed') throw new ApiError(403, 'DATA_RIGHTS_REQUIRED');
    const existing = await env.DB.prepare('SELECT symbol FROM market_series WHERE symbol = ?').bind(series.symbol).first();
    if (!existing) {
      const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM market_series').first<{total: number}>();
      if ((count?.total ?? 64) >= 64) throw new ApiError(409, 'MARKET_LIMIT');
    }
    const {rows, ...metadata} = series;
    const meta = {...metadata, from: rows[0][0], to: rows.at(-1)![0], count: rows.length};
    await env.DB.prepare('INSERT INTO market_series(symbol, metadata, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET metadata=excluded.metadata, payload=excluded.payload, updated_at=excluded.updated_at')
      .bind(series.symbol, JSON.stringify(meta), JSON.stringify(series), Math.floor(Date.now() / 1000)).run();
    const cache = (caches as unknown as {default: Cache}).default;
    context.waitUntil(Promise.all([cache.delete(new Request(new URL('/api/market', request.url))), cache.delete(new Request(new URL(`/api/market/${series.symbol}`, request.url)))]));
    return json({ok: true, symbol: series.symbol, rows: rows.length});
  }
  if (path === '/api/shares' && request.method === 'POST') {
    if (env.SHARING_ENABLED !== 'true') throw new ApiError(503, 'SHARING_UNAVAILABLE');
    if (!origin) throw new ApiError(403, 'ORIGIN_DENIED');
    const limit = boundedInteger(env.MAX_SHARE_BYTES, LIMITS.shareBytes, LIMITS.shareBytes);
    const {snapshot, token} = payloadSchema.parse(await readJson(request, limit + 4096));
    const payload = JSON.stringify(snapshot);
    if (!local && snapshot.series.some(series => series.usage === 'research-only')) throw new ApiError(403, 'DATA_RIGHTS_REQUIRED');
    const size = new TextEncoder().encode(payload).byteLength;
    if (size > limit) throw new ApiError(413, 'TOO_LARGE');
    await verifyTurnstile(request, env, token, origin);
    const id = randomToken(16);
    const deleteToken = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    const expires = now + 30 * 86400;
    const result = await env.DB.prepare(`INSERT INTO shares(id,payload,delete_hash,created_at,expires_at,size_bytes)
      SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT count FROM share_budget WHERE day = ?),0) < ?
      AND (SELECT bytes FROM storage_budget WHERE id = 1) + ? <= ?`)
      .bind(id, payload, await sha256(deleteToken), now, expires, size, new Date(now * 1000).toISOString().slice(0, 10), boundedInteger(env.DAILY_SHARE_LIMIT, 30, 200), size, boundedInteger(env.TOTAL_SHARE_BYTES_LIMIT, 220000000, 250000000)).run();
    if (!result.meta.changes) throw new ApiError(503, 'SHARE_CAPACITY');
    return json({id, deleteToken, expiresAt: new Date(expires * 1000).toISOString()}, 201);
  }
  const shareMatch = /^\/api\/shares\/([a-f0-9]{32})$/.exec(path);
  if (shareMatch && request.method === 'GET') {
    const share = await env.DB.prepare('SELECT payload, expires_at FROM shares WHERE id = ? AND expires_at > ?').bind(shareMatch[1], Math.floor(Date.now() / 1000)).first<{payload: string; expires_at: number}>();
    if (!share) throw new ApiError(404, 'SHARE_NOT_FOUND');
    return json({snapshot: JSON.parse(share.payload), expiresAt: new Date(share.expires_at * 1000).toISOString()});
  }
  if (shareMatch && request.method === 'DELETE') {
    if (!origin) throw new ApiError(403, 'ORIGIN_DENIED');
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'UNAUTHORIZED');
    const result = await env.DB.prepare('DELETE FROM shares WHERE id = ? AND delete_hash = ?').bind(shareMatch[1], await sha256(token)).run();
    if (!result.meta.changes) throw new ApiError(404, 'SHARE_NOT_FOUND');
    return json({ok: true});
  }
  throw new ApiError(404, 'NOT_FOUND');
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    let response: Response;
    try { response = await route(request, env, context); }
    catch (error) {
      if (error instanceof ApiError) response = json({error: error.code}, error.status, error.status === 429 ? {'Retry-After': '60'} : {});
      else if (error instanceof z.ZodError) response = json({error: 'INVALID_INPUT'}, 400);
      else response = json({error: 'SERVICE_UNAVAILABLE'}, 503);
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    headers.set('Vary', 'Origin');
    const origin = allowedOrigin(request, env);
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    return new Response(response.body, {status: response.status, headers});
  },
  async scheduled(_event: ScheduledEvent, env: Env) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM shares WHERE id IN (SELECT id FROM shares WHERE expires_at <= ? ORDER BY expires_at LIMIT 200)').bind(now),
      env.DB.prepare("DELETE FROM share_budget WHERE day < date('now', '-35 days')"),
      env.DB.prepare("DELETE FROM market_budget WHERE day < date('now', '-7 days')"),
      env.DB.prepare('DELETE FROM market_jobs WHERE touched_at < ?').bind(now - 7 * 86400),
      env.DB.prepare('DELETE FROM provider_cache WHERE expires_at < ?').bind(now),
    ]);
  },
};
