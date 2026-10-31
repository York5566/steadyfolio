import { describe, expect, it } from 'vitest';
import { analyze, makeSnapshot, xirr } from '../src/core/engine';
import { defaultConfig, demoSeries } from '../src/core/demo';
import { configSchema, seriesSchema, snapshotSchema, type Config, type PriceSeries } from '../src/core/schema';
import { csvText } from '../src/core/csv';

const stock = (rows: PriceSeries['rows'], extra: Partial<PriceSeries> = {}): PriceSeries => ({symbol:'TEST', name:'Test', currency:'TWD', market:'TW', source:'import', sourceName:'fixture', priceKind:'total-return', asOf:rows.at(-1)![0], rows, ...extra});
const configuration = (extra: Partial<Config> = {}): Config => ({...defaultConfig,start:'2024-01-01',end:'2024-03-31',initial:100,monthly:0, portfolios:[{id:'test',name:'Test',assets:[{symbol:'TEST',weight:100}]}], ...extra});
const flatRows: PriceSeries['rows'] = [['2024-01-02',10],['2024-01-05',10],['2024-02-05',10],['2024-03-05',10]];
const result = (config: Config, series: PriceSeries[]) => analyze(makeSnapshot(config, series));

describe('cash flows and returns', () => {
  it('keeps contributions separate from returns at constant prices', () => {
    const analysis = result(configuration({monthly:100}), [stock(flatRows)]);
    expect(analysis.results[0].final).toBeCloseTo(400);
    expect(analysis.results[0].gain).toBeCloseTo(0);
    expect(analysis.results[0].twr).toBeCloseTo(0);
    expect(analysis.results[0].xirr).toBeCloseTo(0);
    expect(analysis.contributionCount).toBe(4);
  });
  it('uses new contribution prices and retains earlier holdings', () => {
    const analysis = result(configuration({monthly:100}), [stock([['2024-01-02',10],['2024-01-05',20],['2024-02-05',10]])]);
    expect(analysis.results[0].final).toBeCloseTo(250);
    expect(analysis.results[0].invested).toBe(300);
    expect(analysis.results[0].twr).toBeCloseTo(0);
    expect(analysis.results[0].maxDrawdown).toBeCloseTo(-0.5);
  });
  it('invests an initial-zero DCA payment on the first scheduled date', () => {
    const analysis = result(configuration({start:'2024-01-05',initial:0,monthly:100}), [stock(flatRows)]);
    expect(analysis.results[0].invested).toBe(300);
    expect(analysis.results[0].points[0].value).toBe(100);
  });
  it('does not double invest when the initial contribution equals the scheduled day', () => {
    const analysis = result(configuration({start:'2024-01-05',initial:100,monthly:100}), [stock(flatRows)]);
    expect(analysis.results[0].invested).toBe(300);
  });
  it('does not make up a missed first-month payment', () => {
    const analysis = result(configuration({start:'2024-01-06',monthly:100}), [stock([['2024-01-08',10],['2024-02-06',10],['2024-03-06',10]])]);
    expect(analysis.results[0].invested).toBe(300);
  });
  it('skips a month when no common date remains after the nominal date', () => {
    const analysis = result(configuration({monthly:100, day:28}), [stock([['2024-01-02',10],['2024-02-27',10],['2024-03-28',10]])]);
    expect(analysis.results[0].invested).toBe(200);
  });
  it('includes initial fees and makes fee treatment stable for large later deposits', () => {
    const analysis = result(configuration({initial:1,monthly:10000000,feeBps:1000}), [stock(flatRows)]);
    expect(analysis.results[0].final + analysis.results[0].fees).toBeCloseTo(analysis.results[0].invested);
    expect(analysis.results[0].twr).toBeLessThan(0);
    expect(analysis.results[0].twr).toBeGreaterThan(-1);
    expect(analysis.results[0].points[0].nav).toBeCloseTo(100 / 1.1);
  });
  it('computes a known annual XIRR and rejects a zero-day span', () => {
    const annual = xirr([{date:'2023-01-01',amount:-100},{date:'2024-01-01',amount:110}]);
    expect(annual).toBeCloseTo(Math.pow(1.1,365.25/365)-1,10);
    expect(xirr([{date:'2024-01-01',amount:-100},{date:'2024-01-01',amount:110}])).toBeNull();
    expect(xirr([{date:'2023-01-01',amount:-100},{date:'2023-02-01',amount:100},{date:'2024-01-01',amount:110}])).toBeNull();
  });
  it('creates allocation portfolios without rebalancing', () => {
    const config = configuration({portfolios:[{id:'mix',name:'Mix',assets:[{symbol:'TEST',weight:50},{symbol:'OTHER',weight:50}]}]});
    const analysis = result(config, [stock([['2024-01-02',10],['2024-01-05',20],['2024-02-05',30]]), stock(flatRows,{symbol:'OTHER'})]);
    expect(analysis.results[0].final).toBeCloseTo(200);
  });
  it('chains year returns into the total return', () => {
    const analysis = analyze(makeSnapshot(defaultConfig, demoSeries()));
    for (const portfolio of analysis.results) expect(portfolio.yearly.reduce((total, year) => total * (1 + year.return),1)-1).toBeCloseTo(portfolio.twr,10);
  });
});

describe('time and currency integrity', () => {
  it('uses a common period and never fills stock prices', () => {
    const config = configuration({portfolios:[...configuration().portfolios,{id:'late',name:'Late',assets:[{symbol:'LATE',weight:100}]}]});
    const analysis = result(config,[stock(flatRows),stock([['2024-01-05',5],['2024-02-05',5],['2024-03-05',5]],{symbol:'LATE'})]);
    expect(analysis.start).toBe('2024-01-05');
    expect(analysis.results[0].points).toHaveLength(3);
  });
  it('includes FX appreciation in the reporting currency', () => {
    const prices = stock([['2024-01-02',10],['2024-01-03',10],['2024-01-04',10]],{currency:'USD',market:'US'});
    const fx = stock([['2024-01-02',30],['2024-01-03',33],['2024-01-04',36]],{symbol:'USDTWD',market:'FX',priceKind:'fx'});
    expect(result(configuration({initial:300}),[prices,fx]).results[0].final).toBeCloseTo(360);
  });
  it('inverts FX for TWD assets reported in USD', () => {
    const prices = stock([['2024-01-02',10],['2024-01-03',10],['2024-01-04',10]]);
    const fx = stock([['2024-01-02',30],['2024-01-03',33],['2024-01-04',36]],{symbol:'USDTWD',market:'FX',priceKind:'fx'});
    expect(result(configuration({currency:'USD',initial:100}),[prices,fx]).results[0].final).toBeCloseTo(100*30/36);
  });
  it('refuses future-only FX and stale FX', () => {
    const prices = stock(flatRows,{currency:'USD',market:'US'});
    const fx = stock([['2024-01-03',30],['2024-01-04',30],['2024-01-05',30]],{symbol:'USDTWD',market:'FX',priceKind:'fx'});
    expect(() => result(configuration(),[prices,fx])).toThrow('FX_GAP');
    expect(() => result(configuration({start:'2024-01-05'}),[prices,fx])).toThrow('FX_GAP');
  });
  it('rejects mixed price conventions and missing FX', () => {
    const config = configuration({portfolios:[...configuration().portfolios,{id:'other',name:'Other',assets:[{symbol:'OTHER',weight:100}]}]});
    expect(() => makeSnapshot(config,[stock(flatRows),stock(flatRows,{symbol:'OTHER',priceKind:'split-adjusted'})])).toThrow('MIXED_PRICE_KIND');
    expect(() => makeSnapshot(configuration(),[stock(flatRows,{currency:'USD'})])).toThrow('MISSING_FX');
  });
  it('retains reproducibility after serialization', () => {
    const snapshot = makeSnapshot(defaultConfig,demoSeries());
    expect(analyze(snapshot)).toEqual(analyze(JSON.parse(JSON.stringify(snapshot))));
    expect(analyze(snapshot).demo).toBe(true);
  });
});

describe('untrusted input', () => {
  it.each([NaN,Infinity,-1,1e13])('rejects invalid money %s', amount => expect(() => configSchema.parse(configuration({initial:amount}))).toThrow());
  it('rejects impossible dates, duplicate dates, and zero prices', () => {
    expect(() => configSchema.parse(configuration({start:'2024-02-30'}))).toThrow();
    expect(() => seriesSchema.parse(stock([flatRows[0],flatRows[0],flatRows[1]]))).toThrow();
    expect(() => seriesSchema.parse(stock([['2024-01-01',0],flatRows[0],flatRows[1]]))).toThrow();
  });
  it('rejects unknown snapshot versions and extra payload fields', () => {
    const snapshot = makeSnapshot(configuration(),[stock(flatRows)]);
    expect(() => snapshotSchema.parse({...snapshot,engine:'2.0'})).toThrow();
    expect(() => snapshotSchema.parse({...snapshot,url:'http://localhost/secret'})).toThrow();
  });
  it('rejects repeated assets and incorrect weights', () => {
    expect(() => configSchema.parse(configuration({portfolios:[{id:'a',name:'A',assets:[{symbol:'TEST',weight:50}]}]}))).toThrow('INVALID_WEIGHTS');
    expect(() => configSchema.parse(configuration({portfolios:[{id:'a',name:'A',assets:[{symbol:'TEST',weight:50},{symbol:'TEST',weight:50}]}]}))).toThrow('DUPLICATE_ASSET');
  });
  it('neutralizes spreadsheet formula names in CSV exports', () => {
    expect(csvText([['=WEBSERVICE("bad")','+SUM(1)',42]])).toContain("'=WEBSERVICE");
    expect(csvText([['=WEBSERVICE("bad")','+SUM(1)',42]])).toContain("'+SUM(1)");
  });
});
