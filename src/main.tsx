import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { messages, type Locale } from './i18n';
import { footer, siteHeader, siteHero } from './site';
import './style.css';

const locale: Locale = location.pathname.startsWith('/en/') ? 'en' : 'zh-Hant';
document.documentElement.lang = locale;
const siteContent = document.getElementById('site-content');
const siteFooter = document.getElementById('site-footer');
if (siteContent && !siteContent.hasChildNodes()) siteContent.innerHTML = location.pathname.includes('/share/') ? siteHeader(locale, 'share/') : siteHero(locale);
if (siteFooter && !siteFooter.hasChildNodes()) siteFooter.innerHTML = footer(locale, !location.pathname.includes('/share/'));
for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-locale]')) {
  if (location.pathname.includes('/share/') && location.hash) link.hash = location.hash;
}

class ErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {return this.state.failed ? <div className="panel notice error" role="alert">{messages[locale].missing}<p><a href={`/${locale}/`}>{messages[locale].tool}</a></p></div> : this.props.children;}
}
const root = document.getElementById('app');
if (root) createRoot(root).render(<ErrorBoundary><App locale={locale} /></ErrorBoundary>);
