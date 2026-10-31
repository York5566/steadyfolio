import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Snapshot } from '../src/core/schema';
import { readJson, isLocal, sha256 } from '../worker/security';
import worker, {type Env} from '../worker/index';

const context = {waitUntil:vi.fn()} as unknown as ExecutionContext;
function environment(): Env {
  return {ENVIRONMENT:'production',PUBLIC_ORIGIN:'https://example.org',ALLOWED_ORIGINS:'https://example.org',SHARING_ENABLED:'false',TURNSTILE_SITE_KEY:'',READ_LIMITER:{limit:vi.fn().mockResolvedValue({success:true})},WRITE_LIMITER:{limit:vi.fn().mockResolvedValue({success:true})},DB:{prepare:vi.fn()},ASSETS:{fetch:vi.fn()}} as unknown as Env;
}
describe('request boundaries', () => {
  it('rejects actual streamed body sizes without trusting Content-Length', async () => {
    const request = new Request('https://example.org/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"data":"'+ 'a'.repeat(1000)+'"}'});
    await expect(readJson(request,100)).rejects.toMatchObject({status:413});
  });
  it('rejects content-type confusion and malformed JSON', async () => {
    await expect(readJson(new Request('https://example.org',{method:'POST',body:'{}'}),100)).rejects.toMatchObject({status:415});
    await expect(readJson(new Request('https://example.org',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'}),100)).rejects.toMatchObject({status:400});
  });
  it('permits local development bypass only on loopback and local environment', () => {
    expect(isLocal(new Request('https://example.org'), 'local')).toBe(false);
    expect(isLocal(new Request('http://127.0.0.1:8787'), 'production')).toBe(false);
    expect(isLocal(new Request('http://127.0.0.1:8787'), 'local')).toBe(true);
  });
  it('hashes deletion secrets', async () => expect(await sha256('sample')).toMatch(/^[a-f0-9]{64}$/));
  it('blocks unknown origins before database access', async () => {
    const env = environment();
    const response = await worker.fetch(new Request('https://example.org/api/shares',{method:'POST',headers:{Origin:'https://evil.org'}}),env,context);
    expect(response.status).toBe(403);
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('fails closed when a rate limiter is missing', async () => {
    const env = environment();
    env.READ_LIMITER = undefined as unknown as RateLimit;
    const response = await worker.fetch(new Request('https://example.org/api/config'),env,context);
    expect(response.status).toBe(503);
  });
  it('returns retry metadata for throttled requests', async () => {
    const env = environment();
    env.READ_LIMITER.limit = vi.fn().mockResolvedValue({success:false});
    const response = await worker.fetch(new Request('https://example.org/api/config'),env,context);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it('does not query D1 for malformed IDs or unknown paths', async () => {
    const env = environment();
    for (const path of ['/api/shares/%27%20OR%201=1','/api/not-real','/api/market?callback=x']) {
      const response = await worker.fetch(new Request(`https://example.org${path}`),env,context);
      expect([400,404]).toContain(response.status);
    }
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it('disables sharing until configured and returns no sensitive config', async () => {
    const env = environment();env.TURNSTILE_SECRET_KEY='private';env.ADMIN_TOKEN='private-admin';
    const response = await worker.fetch(new Request('https://example.org/api/config'),env,context);
    const body = await response.text();
    expect(body).toContain('"sharingEnabled":false');expect(body).not.toContain('private');
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
  });
  it('rejects unauthenticated administrative imports', async () => {
    const env = environment();env.ADMIN_TOKEN='a'.repeat(64);
    const response = await worker.fetch(new Request('https://example.org/api/admin/market',{method:'POST'}),env,context);
    expect(response.status).toBe(401);expect(env.DB.prepare).not.toHaveBeenCalled();
  });
});

describe('production sharing verification', () => {
  afterEach(() => vi.unstubAllGlobals());
  const snapshot: Snapshot = {schema:1,engine:'1.0.0',createdAt:'2026-10-17T00:00:00Z',config:{start:'2020-01-01',end:'2020-01-03',currency:'USD',initial:100,monthly:0,day:5,feeBps:0,portfolios:[{id:'test',name:'Test',assets:[{symbol:'TEST',weight:100}]}]},series:[{symbol:'TEST',name:'Synthetic test',currency:'USD',market:'US',priceKind:'total-return',source:'demo',sourceName:'Synthetic',asOf:'2020-01-03',rows:[['2020-01-01',100],['2020-01-02',101],['2020-01-03',102]]}]};
  function configured() {
    const env = environment();env.SHARING_ENABLED='true';env.TURNSTILE_SITE_KEY='real-site-key';env.TURNSTILE_SECRET_KEY='private-secret';
    env.DB.prepare = vi.fn().mockReturnValue({bind:vi.fn().mockReturnValue({run:vi.fn().mockResolvedValue({meta:{changes:1}})})});
    return env;
  }
  function request(data = snapshot) {
    return new Request('https://example.org/api/shares',{method:'POST',headers:{Origin:'https://example.org','Content-Type':'application/json'},body:JSON.stringify({snapshot:data,token:'verification-token'})});
  }
  it('creates only after successful hostname and action validation', async () => {
    const env = configured();
    const verify = vi.fn().mockResolvedValue(Response.json({success:true,hostname:'example.org',action:'share'}));
    vi.stubGlobal('fetch',verify);
    const response = await worker.fetch(request(),env,context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({id:expect.stringMatching(/^[a-f0-9]{32}$/),deleteToken:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(verify.mock.calls[0][0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(env.DB.prepare).toHaveBeenCalledOnce();
  });
  it.each([
    {success:false,'error-codes':['timeout-or-duplicate']},
    {success:true,hostname:'evil.org',action:'share'},
    {success:true,hostname:'example.org',action:'login'},
  ])('rejects failed, reused or mismatched verification: %j', async result => {
    const env = configured();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(result)));
    const response = await worker.fetch(request(),env,context);
    expect(response.status).toBe(403);expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it('fails closed on verification network failure', async () => {
    const env = configured();vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
    expect((await worker.fetch(request(),env,context)).status).toBe(503);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it.each(['1x000-test','2x000-test','3x000-test'])('never enables production with test key %s', async key => {
    const env = configured();env.TURNSTILE_SITE_KEY=key;
    expect((await worker.fetch(request(),env,context)).status).toBe(503);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
  it('blocks research-only snapshots before verification or persistence', async () => {
    const env = configured();const copy = structuredClone(snapshot);copy.series[0].usage='research-only';
    const verify = vi.fn();vi.stubGlobal('fetch',verify);
    expect((await worker.fetch(request(copy),env,context)).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();expect(env.DB.prepare).not.toHaveBeenCalled();
  });
});
