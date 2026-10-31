import type { PriceSeries } from './schema';

export type MarketChoice = Pick<PriceSeries, 'symbol' | 'name' | 'market' | 'currency' | 'source'>;
export const marketChoices: MarketChoice[] = [
  {symbol: '0050.TW', name: '元大台灣50', market: 'TW', currency: 'TWD', source: 'market'},
  {symbol: '006208.TW', name: '富邦台50', market: 'TW', currency: 'TWD', source: 'market'},
  {symbol: '2330.TW', name: '台積電', market: 'TW', currency: 'TWD', source: 'market'},
  ...['VTI', 'QQQ', 'VOO', 'SPY', 'VT', 'AAPL', 'MSFT', 'BND'].map(symbol => ({symbol, name: symbol, market: 'US' as const, currency: 'USD' as const, source: 'market' as const})),
];

export function marketSymbol(input: string): string {
  const symbol = input.trim().toUpperCase();
  if (symbol === 'USDTWD' || symbol === 'TWD=X') return 'USDTWD';
  if (/^\d{4,6}$/.test(symbol)) return `${symbol}.TW`;
  if (/^\d{4,6}[A-Z]?\.TW(O)?$/.test(symbol) || /^[A-Z]{1,6}(?:[.-][A-Z])?$/.test(symbol)) return symbol;
  throw new Error('INVALID_SYMBOL');
}

export type HistoryReply = {series: PriceSeries} | {pending: true; completed: number; total: number};
