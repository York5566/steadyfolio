import { describe, expect, it } from 'vitest';
import { money, messages } from '../src/i18n';
import { siteHeader } from '../src/site';
import { defaultConfig, demoSeries } from '../src/core/demo';

describe('localized presentation', () => {
  it('never labels generated investment prices with actual stock tickers', () => {
    const investments = demoSeries().filter(series => series.market !== 'FX');
    expect(investments.every(series => series.symbol.startsWith('DEMO-'))).toBe(true);
    expect(defaultConfig.portfolios.every(portfolio => portfolio.name.startsWith('DEMO '))).toBe(true);
    expect(defaultConfig.portfolios.flatMap(portfolio => portfolio.assets).map(asset => asset.symbol)).toEqual(investments.map(series => series.symbol));
  });
  it('keeps translation keys aligned', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages['zh-Hant']).sort());
  });
  it('always identifies currency and lets long amounts wrap at the currency boundary', () => {
    for (const locale of ['zh-Hant','en'] as const) {
      expect(money(1263476,'TWD',locale)).toBe('TWD 1,263,476');
      expect(money(-36524,'USD',locale)).toContain('USD');
      expect(money(1263476,'TWD',locale)).not.toContain('\u00a0');
    }
  });
  it('points share-page skip links to the rendered workspace', () => {
    expect(siteHeader('zh-Hant','share/')).toContain('class="skip" href="#workspace"');
    expect(siteHeader('en','methodology/')).toContain('class="skip" href="#main"');
  });
});
