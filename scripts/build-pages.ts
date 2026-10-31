import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { footer, siteHeader, siteHero } from '../src/site';
import { messages, type Locale } from '../src/i18n';
import { documentBody, type DocumentPage } from '../src/documents';
import { createHash } from 'node:crypto';
import { productionOrigin } from './site-origin';

const template = await readFile('dist/index.html', 'utf8');
const siteUrl = productionOrigin(process.env.SITE_URL) ?? '';
const validSite = Boolean(siteUrl);
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const sitemap: string[] = [];
const scriptHashes = new Set<string>();
for (const locale of ['zh-Hant', 'en'] as Locale[]) {
  for (const page of ['', 'share', 'methodology', 'privacy', 'about']) {
    const path = `/${locale}/${page ? `${page}/` : ''}`;
    const text = messages[locale];
    const title = page ? `${page === 'share' ? text.sharedTitle : text[page as DocumentPage]} | ${text.brand}` : locale === 'en' ? 'Steadyfolio | Compare long-term monthly investing in Taiwan & US stocks' : '慢慢投 Steadyfolio｜台美股票 ETF 定期定額績效比較';
    const description = page ? page === 'share' ? text.sharedHelp : `${title}。${text.footerNote}` : text.heroText;
    const content = page === '' ? siteHero(locale) : page === 'share' ? siteHeader(locale, 'share/') : siteHeader(locale, `${page}/`) + documentBody(page as DocumentPage, locale);
    const noindex = page === 'share' || !validSite;
    const canonical = validSite && page !== 'share' ? `<link rel="canonical" href="${escape(siteUrl + path)}"><link rel="alternate" hreflang="zh-Hant" href="${escape(siteUrl)}/zh-Hant/${page ? `${page}/` : ''}"><link rel="alternate" hreflang="en" href="${escape(siteUrl)}/en/${page ? `${page}/` : ''}"><link rel="alternate" hreflang="x-default" href="${escape(siteUrl)}/zh-Hant/${page ? `${page}/` : ''}">` : '';
    let html = template.replace('lang="zh-Hant"', `lang="${locale}"`).replace(/<title>.*?<\/title>/, `<title>${escape(title)}</title>`).replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escape(description)}">`)
      .replace('</head>', `${canonical}<meta name="robots" content="${noindex ? 'noindex, nofollow, noarchive' : 'index, follow'}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:type" content="website"><meta property="og:locale" content="${locale === 'en' ? 'en_US' : 'zh_TW'}">${validSite ? `<meta property="og:url" content="${escape(siteUrl + path)}">` : ''}<meta name="twitter:card" content="summary"></head>`)
      .replace('<div id="site-content"></div>', `<div id="site-content">${content}</div>`)
      .replace('<div id="site-footer"></div>', `<div id="site-footer">${footer(locale, !page)}</div>`);
    if (page && page !== 'share') html = html.replace('<div id="app"></div>', '').replace(/<script type="module"[^>]*><\/script>/g, '').replace(/<link rel="modulepreload"[^>]*>/g, '');
    if (!page && validSite) {
      const structured = JSON.stringify({'@context':'https://schema.org','@type':'WebApplication',name:text.brand,url:siteUrl+path,inLanguage:locale,description:text.heroText,applicationCategory:'FinanceApplication',operatingSystem:'Web browser',isAccessibleForFree:true}).replaceAll('<','\\u003c');
      scriptHashes.add(`'sha256-${createHash('sha256').update(structured).digest('base64')}'`);
      html = html.replace('</head>',`<script type="application/ld+json">${structured}</script></head>`);
    }
    await mkdir(`dist${path}`, {recursive: true});
    await writeFile(`dist${path}index.html`, html);
    if (locale === 'zh-Hant' && !page) await writeFile('dist/index.html', html);
    if (!noindex) sitemap.push(`<url><loc>${escape(siteUrl + path)}</loc><lastmod>2026-10-17</lastmod></url>`);
  }
}
const csp = `default-src 'self'; script-src 'self' https://challenges.cloudflare.com ${[...scriptHashes].join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
await writeFile('dist/_headers', `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()\n  Strict-Transport-Security: max-age=31536000\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/:locale/share/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n`);
await writeFile('dist/robots.txt', validSite ? `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /zh-Hant/share/\nDisallow: /en/share/\nSitemap: ${siteUrl}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');
await writeFile('dist/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemap.join('')}</urlset>`);
await writeFile('dist/404.html', template.replace('<div id="site-content"></div>', `${siteHeader('zh-Hant')}<main id="main" class="document"><h1>404 · 找不到這個頁面</h1><p>This page could not be found.</p><a href="/zh-Hant/">回到慢慢投 / Home</a></main>`).replace('<div id="app"></div>', '').replace(/<script type="module"[^>]*><\/script>/g, '').replace('<title>慢慢投 Steadyfolio｜台美股票定期定額比較</title>', '<title>404 | Steadyfolio</title>').replace('</head>', '<meta name="robots" content="noindex"></head>'));
console.log(`Built 10 localized pages; canonical domain: ${validSite ? siteUrl : 'not configured (noindex)'}`);
