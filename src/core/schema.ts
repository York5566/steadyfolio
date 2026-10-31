import { z } from 'zod';

export const ENGINE_VERSION = '1.0.0';
export const LIMITS = { portfolios: 12, assets: 12, rows: 12000, shareBytes: 524288, fileBytes: 4000000 };
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '1990-01-01' && value <= '2100-12-31';
}, 'INVALID_DATE');
export const symbolSchema = z.string().regex(/^[A-Z0-9^][A-Z0-9.^=\-]{0,23}$/);
export const currencySchema = z.enum(['TWD', 'USD']);
const positive = z.number().finite().positive().max(1e9);
export const seriesSchema = z.object({
  symbol: symbolSchema,
  name: z.string().trim().min(1).max(80),
  currency: currencySchema,
  market: z.enum(['TW', 'US', 'FX']),
  priceKind: z.enum(['total-return', 'split-adjusted', 'fx']),
  source: z.enum(['demo', 'import', 'market']),
  sourceName: z.string().trim().min(1).max(160),
  usage: z.enum(['research-only', 'redistribution-licensed']).optional(),
  asOf: isoDate,
  rows: z.array(z.tuple([isoDate, positive])).min(3).max(LIMITS.rows),
}).strict().superRefine((series, context) => {
  if (series.rows.some((row, index) => index > 0 && row[0] <= series.rows[index - 1][0])) {
    context.addIssue({code: 'custom', message: 'DATES_NOT_SORTED'});
  }
  if (series.asOf < series.rows.at(-1)![0]) context.addIssue({code: 'custom', message: 'INVALID_AS_OF'});
  if ((series.market === 'FX') !== (series.priceKind === 'fx') || (series.market === 'FX' && (series.symbol !== 'USDTWD' || series.currency !== 'TWD'))) {
    context.addIssue({code: 'custom', message: 'INVALID_FX'});
  }
});
export const configSchema = z.object({
  start: isoDate,
  end: isoDate,
  currency: currencySchema,
  initial: z.number().finite().min(0).max(1e9),
  monthly: z.number().finite().min(0).max(1e7),
  day: z.number().int().min(1).max(28),
  feeBps: z.number().finite().min(0).max(1000),
  portfolios: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    name: z.string().trim().min(1).max(60),
    assets: z.array(z.object({symbol: symbolSchema, weight: z.number().finite().positive().max(100)}).strict()).min(1).max(LIMITS.assets),
  }).strict()).min(1).max(LIMITS.portfolios),
}).strict().superRefine((config, context) => {
  const fail = (message: string) => context.addIssue({code: 'custom', message});
  if (config.start >= config.end) fail('INVALID_PERIOD');
  if (config.initial + config.monthly <= 0) fail('NO_CONTRIBUTION');
  if (new Set(config.portfolios.map(portfolio => portfolio.id)).size !== config.portfolios.length) fail('DUPLICATE_PORTFOLIO');
  for (const portfolio of config.portfolios) {
    if (Math.abs(portfolio.assets.reduce((sum, asset) => sum + asset.weight, 0) - 100) > 0.00001) fail('INVALID_WEIGHTS');
    if (new Set(portfolio.assets.map(asset => asset.symbol)).size !== portfolio.assets.length) fail('DUPLICATE_ASSET');
  }
  if (new Set(config.portfolios.flatMap(portfolio => portfolio.assets.map(asset => asset.symbol))).size > LIMITS.assets) fail('TOO_MANY_ASSETS');
});
export const snapshotSchema = z.object({
  schema: z.literal(1),
  engine: z.literal(ENGINE_VERSION),
  createdAt: z.string().datetime(),
  config: configSchema,
  series: z.array(seriesSchema).min(1).max(LIMITS.assets + 1),
}).strict().superRefine((snapshot, context) => {
  const bySymbol = new Map(snapshot.series.map(series => [series.symbol, series]));
  const used = new Set(snapshot.config.portfolios.flatMap(portfolio => portfolio.assets.map(asset => asset.symbol)));
  if (bySymbol.size !== snapshot.series.length) context.addIssue({code: 'custom', message: 'DUPLICATE_SERIES'});
  for (const symbol of used) {
    if (!bySymbol.has(symbol) || bySymbol.get(symbol)!.market === 'FX') context.addIssue({code: 'custom', message: 'MISSING_DATA'});
  }
  const kinds = new Set([...used].map(symbol => bySymbol.get(symbol)?.priceKind));
  if (kinds.size > 1) context.addIssue({code: 'custom', message: 'MIXED_PRICE_KIND'});
  if ([...used].some(symbol => bySymbol.get(symbol)?.currency !== snapshot.config.currency) && !bySymbol.has('USDTWD')) {
    context.addIssue({code: 'custom', message: 'MISSING_FX'});
  }
});
export type PriceSeries = z.infer<typeof seriesSchema>;
export type Config = z.infer<typeof configSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Currency = z.infer<typeof currencySchema>;

export function problemCode(error: unknown): string {
  if (error instanceof z.ZodError) {
    const custom = error.issues.find(issue => issue.code === 'custom');
    return custom?.message ?? 'INVALID_INPUT';
  }
  return error instanceof Error ? error.message : 'UNKNOWN_ERROR';
}
