import { messages, type Locale } from './i18n';

export function siteHeader(locale: Locale, page = ''): string {
  const text = messages[locale];
  const other = locale === 'zh-Hant' ? 'en' : 'zh-Hant';
  return `<a class="skip" href="#${page === 'share/' ? 'workspace' : 'main'}">${locale === 'en' ? 'Skip to content' : '跳至主要內容'}</a><header class="site-header"><a class="brand" href="/${locale}/"><img src="/favicon.svg" width="36" height="36" alt=""><span>${text.brand}<small>${text.tagline}</small></span></a><nav aria-label="${locale === 'en' ? 'Main navigation' : '主要導覽'}"><a href="/${locale}/#workspace">${text.tool}</a><a href="/${locale}/methodology/">${text.methodology}</a><a class="language" data-locale="${other}" href="/${other}/${page}">${locale === 'en' ? '繁體中文' : 'English'} ↗</a></nav></header>`;
}
export function siteHero(locale: Locale): string {
  const text = messages[locale];
  return `${siteHeader(locale)}<main id="main"><section class="hero"><div><p class="eyebrow"><span></span>${text.eyebrow}</p><h1>${text.heroTitle.replace('\n', '<br>')}</h1><p class="hero-description">${text.heroText}</p><div class="hero-links"><a class="button primary" href="#workspace">${text.heroLink} <span>↗</span></a><a class="text-link" href="/${locale}/methodology/">${text.heroSecondary} →</a></div><p class="hero-hint">${text.heroHint}</p></div><aside class="hero-aside"><div class="growth-art" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div><p class="eyebrow">THE LONG VIEW</p><h2>${text.heroSideTitle}</h2><p>${text.heroSideText}</p></aside></section><div class="journey" aria-label="${text.tool}"><span><b>01</b>${text.step1}</span><span><b>02</b>${text.step2}</span><span><b>03</b>${text.step3}</span></div></main>`;
}
export function footer(locale: Locale, full = true): string {
  const text = messages[locale];
  return `${full ? `<section class="editorial"><p class="eyebrow">INVEST WITH PERSPECTIVE</p><h2>${text.tipsTitle}</h2><div class="tips">${text.tips.map(([title, body], index) => `<article><span>0${index + 1}</span><h3>${title}</h3><p>${body}</p></article>`).join('')}</div></section><section class="faq"><h2>${text.faqTitle}</h2><div>${text.faq.map(([question, answer]) => `<details><summary>${question}</summary><p>${answer}</p></details>`).join('')}</div></section>` : ''}<footer class="footer"><div><a class="brand" href="/${locale}/">${text.brand}</a><p>${text.footerNote}</p></div><nav><a href="/${locale}/methodology/">${text.methodology}</a><a href="/${locale}/privacy/">${text.privacy}</a><a href="/${locale}/about/">${text.about}</a></nav><small>© 2026 Steadyfolio · v1.0.0</small></footer>`;
}
