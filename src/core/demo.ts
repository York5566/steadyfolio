import type { Config, PriceSeries } from './schema';

export function demoSeries(): PriceSeries[] {
  const definitions = [
    {symbol: 'DEMO-TW', name: 'Synthetic series A', currency: 'TWD', market: 'TW', priceKind: 'total-return', seed: 23, price: 55, drift: 0.00035},
    {symbol: 'DEMO-US-A', name: 'Synthetic series B', currency: 'USD', market: 'US', priceKind: 'total-return', seed: 29, price: 90, drift: 0.00032},
    {symbol: 'DEMO-US-B', name: 'Synthetic series C', currency: 'USD', market: 'US', priceKind: 'total-return', seed: 41, price: 95, drift: 0.00042},
    {symbol: 'USDTWD', name: '1 USD → TWD', currency: 'TWD', market: 'FX', priceKind: 'fx', seed: 37, price: 31, drift: 0},
  ] as const;
  return definitions.map(definition => {
    let state: number = definition.seed;
    let price: number = definition.price;
    const rows: PriceSeries['rows'] = [];
    for (let stamp = Date.parse('2015-01-01'); stamp <= Date.parse('2025-12-31'); stamp += 86400000) {
      const date = new Date(stamp);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const noise = state / 4294967296 - 0.5;
      const dateText = date.toISOString().slice(0, 10);
      const shock = dateText >= '2020-02-20' && dateText <= '2020-03-23' ? -0.015 : dateText >= '2022-01-03' && dateText <= '2022-06-30' ? -0.002 : 0;
      price *= Math.exp(definition.drift + noise * (definition.market === 'FX' ? 0.004 : 0.026) + (definition.market === 'FX' ? 0 : shock));
      rows.push([dateText, Math.round(price * 1e6) / 1e6]);
    }
    return {symbol: definition.symbol, name: definition.name, currency: definition.currency, market: definition.market, priceKind: definition.priceKind, source: 'demo', sourceName: 'Synthetic demo / 合成示範；非真實行情', asOf: '2025-12-31', rows};
  });
}

export const defaultConfig: Config = {
  start: '2016-01-01', end: '2025-12-31', currency: 'TWD', initial: 100000, monthly: 10000, day: 5, feeBps: 0,
  portfolios: [
    {id: 'demo-a', name: 'DEMO A', assets: [{symbol: 'DEMO-TW', weight: 100}]},
    {id: 'demo-b', name: 'DEMO B', assets: [{symbol: 'DEMO-US-A', weight: 100}]},
    {id: 'demo-c', name: 'DEMO C', assets: [{symbol: 'DEMO-US-B', weight: 100}]},
  ],
};
