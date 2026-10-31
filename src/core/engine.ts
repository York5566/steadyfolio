import { ENGINE_VERSION, snapshotSchema, type Config, type PriceSeries, type Snapshot } from './schema';

const DAY = 86400000;
export const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY;
export type Point = { date: string; value: number; invested: number; nav: number; drawdown: number };
export type Result = {
  id: string; name: string; points: Point[]; final: number; invested: number; gain: number;
  simpleReturn: number; xirr: number | null; twr: number; maxDrawdown: number; fees: number;
  yearly: { year: string; return: number }[];
};
export type Analysis = { results: Result[]; start: string; end: string; shortened: boolean; sparse: boolean; demo: boolean; sourceMix: boolean; contributionCount: number; priceKind: string };

export function xirr(flows: { date: string; amount: number }[]): number | null {
  const active = flows.filter(flow => flow.amount !== 0);
  if (active.length < 2 || active.at(-1)!.amount <= 0 || active.slice(0, -1).some(flow => flow.amount >= 0)) return null;
  const origin = dayNumber(active[0].date);
  if (dayNumber(active.at(-1)!.date) <= origin) return null;
  const discounted = (logRate: number) => active.reduce((sum, flow) => sum + flow.amount * Math.exp(-logRate * (dayNumber(flow.date) - origin) / 365.25), 0);
  let low = -20;
  let high = 20;
  if (!(discounted(low) >= 0 && discounted(high) <= 0)) return null;
  for (let iteration = 0; iteration < 160; iteration++) {
    const middle = (low + high) / 2;
    if (discounted(middle) > 0) low = middle;
    else high = middle;
  }
  const rate = Math.expm1((low + high) / 2);
  return Number.isFinite(rate) ? rate : null;
}

export function analyze(input: Snapshot): Analysis {
  const snapshot = snapshotSchema.parse(input);
  const { config } = snapshot;
  const symbols = [...new Set(config.portfolios.flatMap(portfolio => portfolio.assets.map(asset => asset.symbol)))];
  const seriesMap = new Map(snapshot.series.map(series => [series.symbol, series]));
  const priceMaps = new Map(snapshot.series.map(series => [series.symbol, new Map(series.rows)]));
  const dates = seriesMap.get(symbols[0])!.rows.map(row => row[0]).filter(date => date >= config.start && date <= config.end && symbols.every(symbol => priceMaps.get(symbol)!.has(date)));
  if (dates.length < 3) throw new Error('NO_COMMON_PERIOD');
  const fx = seriesMap.get('USDTWD');
  const needsFx = symbols.some(symbol => seriesMap.get(symbol)!.currency !== config.currency);
  let fxCursor = -1;
  const prices = dates.map(date => {
    if (needsFx) {
      while (fxCursor + 1 < fx!.rows.length && fx!.rows[fxCursor + 1][0] <= date) fxCursor++;
      if (fxCursor < 0 || dayNumber(date) - dayNumber(fx!.rows[fxCursor][0]) > 7) throw new Error('FX_GAP');
    }
    return new Map(symbols.map(symbol => {
      const original = priceMaps.get(symbol)!.get(date)!;
      const currency = seriesMap.get(symbol)!.currency;
      const rate = currency === config.currency ? 1 : config.currency === 'TWD' ? fx!.rows[fxCursor][1] : 1 / fx!.rows[fxCursor][1];
      return [symbol, original * rate];
    }));
  });
  const deposits = dates.map(() => 0);
  deposits[0] = config.initial;
  const months = [...new Set(dates.map(date => date.slice(0, 7)))];
  for (const month of months) {
    const nominal = `${month}-${String(config.day).padStart(2, '0')}`;
    if (nominal < dates[0] || (nominal === dates[0] && config.initial > 0)) continue;
    const index = dates.findIndex(date => date.slice(0, 7) === month && date >= nominal);
    if (index >= 0) deposits[index] += config.monthly;
  }
  const totalInvested = deposits.reduce((sum, amount) => sum + amount, 0);
  if (totalInvested === 0) throw new Error('NO_SCHEDULED_CONTRIBUTION');
  const results = config.portfolios.map(portfolio => {
    const holdings = new Map(portfolio.assets.map(asset => [asset.symbol, 0]));
    const points: Point[] = [];
    let invested = 0;
    let fees = 0;
    let nav = 100;
    let peak = 100;
    let previous = 0;
    for (const [index, date] of dates.entries()) {
      const before = portfolio.assets.reduce((sum, asset) => sum + holdings.get(asset.symbol)! * prices[index].get(asset.symbol)!, 0);
      const deposit = deposits[index];
      const cost = deposit - deposit / (1 + config.feeBps / 10000);
      const net = deposit - cost;
      for (const asset of portfolio.assets) holdings.set(asset.symbol, holdings.get(asset.symbol)! + net * asset.weight / 100 / prices[index].get(asset.symbol)!);
      invested += deposit;
      fees += cost;
      const value = before + net;
      if (previous > 0) nav *= before / previous;
      if (before + deposit > 0) nav *= value / (before + deposit);
      if (!Number.isFinite(value) || !Number.isFinite(nav) || nav <= 0) throw new Error('NUMERIC_RANGE');
      peak = Math.max(peak, nav);
      points.push({date, value, invested, nav, drawdown: nav / peak - 1});
      previous = value;
    }
    const final = points.at(-1)!.value;
    let previousYearNav = 100;
    const yearly = [...new Set(dates.map(date => date.slice(0, 4)))].map(year => {
      const lastNav = points.filter(point => point.date.startsWith(year)).at(-1)!.nav;
      const annual = {year, return: lastNav / previousYearNav - 1};
      previousYearNav = lastNav;
      return annual;
    });
    return {
      id: portfolio.id, name: portfolio.name, points, final, invested, gain: final - invested,
      simpleReturn: final / invested - 1, twr: nav / 100 - 1, fees,
      xirr: xirr([...dates.map((date, index) => ({date, amount: -deposits[index]})), {date: dates.at(-1)!, amount: final}]),
      maxDrawdown: Math.min(0, ...points.map(point => point.drawdown)), yearly,
    };
  });
  return {
    results, start: dates[0], end: dates.at(-1)!,
    shortened: dayNumber(dates[0]) - dayNumber(config.start) > 7 || dayNumber(config.end) - dayNumber(dates.at(-1)!) > 7,
    sparse: dates.some((date, index) => index > 0 && dayNumber(date) - dayNumber(dates[index - 1]) > 14),
    demo: snapshot.series.some(series => series.source === 'demo'),
    sourceMix: new Set(snapshot.series.map(series => series.source)).size > 1,
    contributionCount: deposits.filter(amount => amount > 0).length,
    priceKind: seriesMap.get(symbols[0])!.priceKind,
  };
}

export function makeSnapshot(config: Config, available: PriceSeries[]): Snapshot {
  const symbols = new Set(config.portfolios.flatMap(portfolio => portfolio.assets.map(asset => asset.symbol)));
  if (available.some(series => symbols.has(series.symbol) && series.currency !== config.currency)) symbols.add('USDTWD');
  const from = dayNumber(config.start) - 7;
  const series = available.filter(series => symbols.has(series.symbol)).map(series => ({...series, rows: series.rows.filter(row => dayNumber(row[0]) >= from && row[0] <= config.end)}));
  return snapshotSchema.parse({schema: 1, engine: ENGINE_VERSION, createdAt: new Date().toISOString(), config, series});
}
