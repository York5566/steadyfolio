import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { productionOrigin } from './site-origin';

const checks: string[] = [];
const dist = resolve('dist');
let links = 0;
const origin = productionOrigin(process.env.SITE_URL);
const headers = await readFile('dist/_headers','utf8');
for (const locale of ['zh-Hant','en']) {
  for (const page of ['','share','methodology','privacy','about']) {
    const relative = `${locale}/${page ? page+'/' : ''}index.html`;
    const html = await readFile(resolve(dist,relative),'utf8');
    assert.ok(html.includes(`lang="${locale}"`));
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length,page === 'share' ? 0 : 1);
    assert.match(html,/<meta name="description" content="[^\"]{20,}"/);
    assert.match(html,/<meta property="og:title"/);
    if (page === 'share') assert.match(html,/noindex, nofollow, noarchive/);
    if (origin && page !== 'share') {
      assert.ok(html.includes(`rel="canonical" href="${origin}/${locale}/${page ? page+'/' : ''}"`));
      for (const language of ['zh-Hant','en','x-default']) assert.ok(html.includes(`hreflang="${language}"`));
      assert.ok(!html.includes('content="noindex, nofollow, noarchive"'));
    } else assert.match(html,/noindex, nofollow, noarchive/);
    if (origin && !page) {
      const structured = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1];
      assert.equal(JSON.parse(structured)['@type'],'WebApplication');
      assert.ok(headers.includes(`'sha256-${createHash('sha256').update(structured).digest('base64')}'`));
    }
    if (['methodology','privacy','about'].includes(page)) assert.ok(!html.includes('<script type="module"'));
    for (const match of html.matchAll(/(?:href|src)="([^\"]+)"/g)) {
      const href = match[1].split('#')[0].split('?')[0];
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      const path = resolve(dist,'.'+href+(href.endsWith('/')?'index.html':''));
      assert.ok(path.startsWith(dist));
      await access(path);
      links++;
    }
    checks.push(relative);
  }
}
const notFound = await readFile('dist/404.html','utf8');
assert.match(notFound,/404/);assert.match(notFound,/noindex/);
assert.match(headers,/frame-ancestors 'none'/);assert.match(headers,/Referrer-Policy: no-referrer/);
assert.ok(!headers.includes('/*/share/*'));
for (const file of ['robots.txt','sitemap.xml','favicon.svg']) await access(resolve(dist,file));
const sitemap = await readFile('dist/sitemap.xml','utf8');
assert.equal((sitemap.match(/<url>/g) ?? []).length,origin ? 8 : 0);
assert.ok(!sitemap.includes('/share/'));
await mkdir('acceptance',{recursive:true});
await writeFile('acceptance/static-site.json',JSON.stringify({testedAt:new Date().toISOString(),pages:checks,localLinks:links},null,2));
console.log(`${checks.length} localized static pages and ${links} local links/assets passed.`);
