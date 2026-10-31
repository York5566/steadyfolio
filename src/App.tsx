import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, download } from './api';
import { demoSeries, defaultConfig } from './core/demo';
import { type Analysis, type Result, dayNumber, makeSnapshot } from './core/engine';
import { csvText } from './core/csv';
import { marketChoices, marketSymbol } from './core/market';
import { loadHistory } from './market-api';
import { configSchema, LIMITS, problemCode, snapshotSchema, type Config, type Currency, type PriceSeries, type Snapshot } from './core/schema';
import { errorText, messages, money, percent, type Locale } from './i18n';
import { Dialog } from './components/Dialog';
import { Share, type Receipt } from './components/Share';

const Chart = lazy(() => import('./components/Chart').then(module => ({default: module.Chart})));
type Completed = {snapshot: Snapshot; analysis: Analysis; data: PriceSeries[]};
const receiptPattern = /^[a-f0-9]{32}$/;

export function App({locale}: {locale: Locale}) {
  const text = messages[locale];
  const [config, setConfig] = useState<Config>(() => ({...structuredClone(defaultConfig), portfolios: []}));
  const [available, setAvailable] = useState<PriceSeries[]>([]);
  const [source, setSource] = useState<'demo' | 'market' | 'imported'>('market');
  const [completed, setCompleted] = useState<Completed | null>(null);
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [marketProgress, setMarketProgress] = useState('');
  const [error, setError] = useState('');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [shared, setShared] = useState(location.pathname.includes('/share/'));
  const [sharedExpiry, setSharedExpiry] = useState('');
  const [dialog, setDialog] = useState<'add' | 'share' | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{key: 'final' | 'xirr' | 'maxDrawdown'; ascending: boolean}>({key: 'final', ascending: false});
  const marketController = useRef<AbortController | null>(null);
  const worker = useRef<Worker | null>(null);
  const runNumber = useRef(0);
  const settingsElement = useRef<HTMLElement>(null);
  const resultElement = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const receiptInput = useRef<HTMLInputElement>(null);
  const pendingReceipt = useRef<Receipt | null>(null);
  const [manageReceipt, setManageReceipt] = useState<Receipt | null>(null);
  const usedSnapshot = completed?.snapshot;
  const dirty = completed && (JSON.stringify(config) !== JSON.stringify(completed.snapshot.config) || completed.data !== available);
  const choices = [...new Map((source === 'market' ? [...marketChoices, ...available] : available).map(series => [series.symbol, series])).values()].filter(series => series.market !== 'FX');

  function progress(symbol: string, completed?: number, total?: number) {
    setMarketProgress(`${text.fetching} ${symbol}${total ? ` · ${completed}/${total} ${text.months}` : ''}`);
  }
  function beginFetch() {
    marketController.current?.abort();
    const controller = new AbortController();
    marketController.current = controller;
    setLoadingMarket(true);setError('');setRefreshFailed(false);
    return controller;
  }
  function finishFetch(controller: AbortController) {
    if (marketController.current === controller) {setLoadingMarket(false);setMarketProgress('');marketController.current = null;}
  }
  async function fetchData(nextConfig: Config, signal: AbortSignal) {
    const symbols = [...new Set(nextConfig.portfolios.flatMap(portfolio => portfolio.assets.map(asset => asset.symbol)))];
    const loaded: PriceSeries[] = [];
    for (const symbol of symbols) loaded.push(await loadHistory(symbol, nextConfig.start, nextConfig.end, signal, progress));
    if (loaded.some(series => series.currency !== nextConfig.currency)) {
      const earlier = new Date(`${nextConfig.start}T00:00:00Z`);
      earlier.setUTCDate(earlier.getUTCDate() - 7);
      const fxStart = earlier.toISOString().slice(0, 10);
      loaded.push(await loadHistory('USDTWD', fxStart < '1990-01-01' ? '1990-01-01' : fxStart, nextConfig.end, signal, progress));
    }
    return loaded;
  }

  function calculate(snapshot: Snapshot, scroll = false, data = available) {
    worker.current?.terminate();
    const number = ++runNumber.current;
    setBusy(true); setError('');
    const calculation = new Worker(new URL('./core/calculation.worker.ts', import.meta.url), {type: 'module'});
    worker.current = calculation;
    calculation.onmessage = event => {
      if (number !== runNumber.current) return;
      if (event.data.error) {setError(errorText(event.data.error, locale));setRefreshFailed(true);}
      else {
        setRefreshFailed(false);
        setCompleted({snapshot, analysis: event.data.analysis, data});
        setFocus(snapshot.config.portfolios[0].id);
        if (scroll) setTimeout(() => resultElement.current?.scrollIntoView({behavior: 'smooth', block: 'start'}), 50);
      }
      setBusy(false); calculation.terminate(); worker.current = null;
    };
    calculation.onerror = () => {setError(errorText('SERVICE_UNAVAILABLE', locale));setRefreshFailed(true);setBusy(false);calculation.terminate();worker.current = null;};
    calculation.postMessage(snapshot);
  }
  async function run() {
    const controller = beginFetch();
    try {
      const parsed = configSchema.parse(config);
      const data = source === 'market' ? await fetchData(parsed, controller.signal) : available;
      controller.signal.throwIfAborted();
      setAvailable(data);
      calculate(makeSnapshot(parsed, data), true, data);
    }
    catch (error) {if (!controller.signal.aborted) {setError(errorText(problemCode(error), locale));setRefreshFailed(true);}}
    finally {finishFetch(controller);}
  }
  function adoptSnapshot(input: unknown, mode: 'share' | 'file') {
    const snapshot = snapshotSchema.parse(input);
    setConfig(snapshot.config); setAvailable(snapshot.series); setSource(snapshot.series.every(series => series.source === 'demo') ? 'demo' : 'imported');
    if (mode === 'file') {setShared(false); history.replaceState(null, '', `/${locale}/#workspace`);}
    calculate(snapshot, false, snapshot.series);
  }
  useEffect(() => {
    if (location.pathname.includes('/share/')) {
      const id = location.hash.slice(1);
      if (!receiptPattern.test(id)) {setError(errorText('SHARE_NOT_FOUND', locale)); return;}
      const controller = new AbortController();
      setBusy(true);
      api<{snapshot: Snapshot; expiresAt: string}>(`/api/shares/${id}`, {signal: controller.signal}).then(result => {
        if (controller.signal.aborted) return;
        setSharedExpiry(result.expiresAt); adoptSnapshot(result.snapshot, 'share');
      }).catch(error => {if (!controller.signal.aborted) {setError(errorText(problemCode(error), locale));setBusy(false);}});
      return () => {controller.abort();worker.current?.terminate();};
    }
    const controller = new AbortController();
    loadMarket(controller.signal);
    return () => {controller.abort();marketController.current?.abort();worker.current?.terminate();};
  }, []);
  function change<Key extends keyof Config>(key: Key, value: Config[Key]) {setConfig(current => ({...current, [key]: value}));}
  function portfolioChange(id: string, update: Partial<Config['portfolios'][number]>) {setConfig(current => ({...current, portfolios: current.portfolios.map(portfolio => portfolio.id === id ? {...portfolio, ...update} : portfolio)}));}
  const freshId = () => `p${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  async function ensureMarketSeries(symbol: string, signal: AbortSignal) {
    if (source !== 'market' || available.some(series => series.symbol === symbol)) return;
    const loaded = await loadHistory(symbol, config.start, config.end, signal, progress);
    setAvailable(current => [...current.filter(series => series.symbol !== symbol), loaded]);
  }
  async function selectAsset(id: string, assetIndex: number, symbol: string) {
    const controller = beginFetch();
    try {
      await ensureMarketSeries(symbol, controller.signal);
      const portfolio = config.portfolios.find(entry => entry.id === id)!;
      portfolioChange(id, {assets: portfolio.assets.map((entry, index) => index === assetIndex ? {...entry, symbol} : entry)});
    } catch (error) {if (!controller.signal.aborted) setError(errorText(problemCode(error), locale));}
    finally {finishFetch(controller);}
  }
  async function addAsset(series: Pick<PriceSeries, 'symbol'>) {
    if (config.portfolios.length >= LIMITS.portfolios) return;
    const controller = beginFetch();
    try {
      const symbol = source === 'market' ? marketSymbol(series.symbol) : series.symbol;
      if (symbol === 'USDTWD') throw new Error('INVALID_SYMBOL');
      if (new Set([...config.portfolios.flatMap(portfolio => portfolio.assets.map(asset => asset.symbol)), symbol]).size > LIMITS.assets) throw new Error('TOO_MANY_ASSETS');
      await ensureMarketSeries(symbol, controller.signal);
      const id = freshId();
      change('portfolios', [...config.portfolios, {id, name: symbol, assets: [{symbol, weight: 100}]}]);
      setDialog(null);
    } catch (error) {if (!controller.signal.aborted) setError(errorText(problemCode(error), locale));}
    finally {finishFetch(controller);}
  }
  function addMix() {
    const selected = available.filter(series => series.market !== 'FX').slice(0, 2);
    if (!selected.length || config.portfolios.length >= LIMITS.portfolios) return;
    const id = freshId();
    change('portfolios', [...config.portfolios, {id, name: `${text.allocation} ${config.portfolios.length + 1}`, assets: selected.map(series => ({symbol: series.symbol, weight: 100 / selected.length}))}]);
  }
  function showDemo() {
    const series = demoSeries();
    const nextConfig = structuredClone(defaultConfig);
    setAvailable(series);setConfig(nextConfig);setSource('demo');setNotice('');setError('');
    calculate(makeSnapshot(nextConfig, series), false, series);
  }
  async function loadMarket(signal?: AbortSignal) {
    const controller = beginFetch();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    setNotice('');
    setCompleted(null);setSource('market');setAvailable([]);
    const nextConfig = {...config, portfolios: ['0050.TW', 'VTI', 'QQQ'].map(symbol => ({id: freshId(), name: symbol, assets: [{symbol, weight: 100}]}))};
    setConfig(nextConfig);
    try {
      const loaded = await fetchData(configSchema.parse(nextConfig), combined);
      combined.throwIfAborted();
      setAvailable(loaded);
      calculate(makeSnapshot(nextConfig, loaded), false, loaded);
    } catch (error) {if (!combined.aborted) setError(errorText(problemCode(error), locale));}
    finally {finishFetch(controller);}
  }
  async function handleProject(file?: File) {
    if (!file) return;
    try {if (file.size > LIMITS.fileBytes) throw new Error('TOO_LARGE');adoptSnapshot(JSON.parse(await file.text()), 'file');setNotice(text.ok);}
    catch (error) {setError(errorText(problemCode(error), locale));}
  }
  async function readReceipt(file?: File) {
    if (!file) return;
    try {
      if (file.size > 10000) throw new Error('TOO_LARGE');
      const receipt = JSON.parse(await file.text()) as Receipt;
      if (receipt.schema !== 1 || !receiptPattern.test(receipt.id) || !/^[a-f0-9]{64}$/.test(receipt.deleteToken) || receipt.apiOrigin !== (import.meta.env.VITE_API_BASE || location.origin)) throw new Error('INVALID_INPUT');
      pendingReceipt.current = receipt;setManageReceipt(receipt);
    } catch (error) {setError(errorText(problemCode(error), locale));}
  }
  async function revokeReceipt() {
    if (!pendingReceipt.current) return;
    try {await api(`/api/shares/${pendingReceipt.current.id}`, {method: 'DELETE', headers: {Authorization: `Bearer ${pendingReceipt.current.deleteToken}`}});setNotice(text.deleted);setManageReceipt(null);pendingReceipt.current = null;}
    catch (error) {setError(errorText(problemCode(error), locale));setManageReceipt(null);}
  }
  function exportDaily() {
    if (!completed) return;
    const {snapshot, analysis} = completed;
    const header = ['Date', 'Portfolio', `Value (${snapshot.config.currency})`, `Contributions (${snapshot.config.currency})`, `Gain (${snapshot.config.currency})`, 'NAV', 'Drawdown', 'Data status', 'Engine'];
    const rows = analysis.results.flatMap(result => result.points.map(point => [point.date, result.name, point.value, point.invested, point.value - point.invested, point.nav, point.drawdown, analysis.demo ? 'SYNTHETIC DEMO - NOT MARKET DATA' : 'Historical data', snapshot.engine]));
    download('steadyfolio-daily.csv', csvText([header, ...rows]), 'text/csv;charset=utf-8');
  }
  const focused = completed?.analysis.results.find(result => result.id === focus) ?? completed?.analysis.results[0];
  const sorted = completed?.analysis.results.slice().sort((first, second) => {
    const firstValue = first[sort.key], secondValue = second[sort.key];
    if (firstValue === null) return 1;
    if (secondValue === null) return -1;
    return (firstValue - secondValue) * (sort.ascending ? 1 : -1);
  });
  const metric = (result: Result, key: 'final' | 'gain' | 'invested' | 'xirr' | 'maxDrawdown' | 'simpleReturn' | 'twr') => ['final', 'gain', 'invested'].includes(key) ? money(result[key]!, usedSnapshot!.config.currency, locale) : percent(result[key], locale);
  const moneyInput = (key: 'initial' | 'monthly') => <label>{text[key]} <span className="unit">{config.currency}</span><input type="number" inputMode="decimal" min="0" max={key === 'initial' ? '1000000000' : '10000000'} step="1000" value={config[key]} onChange={event => change(key, event.target.valueAsNumber)} /></label>;

  return <section id="workspace" className={`workspace${shared ? ' shared-workspace' : ''}`} aria-label={text.tool}>
    <input type="file" ref={fileInput} accept=".json,application/json" hidden onChange={event => {handleProject(event.target.files?.[0]);event.target.value = '';}} />
    <input type="file" ref={receiptInput} accept=".json,application/json" hidden onChange={event => {readReceipt(event.target.files?.[0]);event.target.value = '';}} />
    {notice && <div className="notice global-notice" role="status">{notice}<button aria-label={text.close} onClick={() => setNotice('')}>×</button></div>}
    {shared ? <div className="shared-banner"><div><p className="eyebrow">SHARED ANALYSIS</p><h1>{text.sharedTitle}</h1><p>{text.sharedHelp}</p>{sharedExpiry && <p className="help">{text.expires}：{new Date(sharedExpiry).toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-TW')}</p>}</div><button className="primary" disabled={!completed} onClick={() => {setShared(false); history.replaceState(null, '', `/${locale}/#workspace`);setTimeout(() => settingsElement.current?.scrollIntoView({behavior: 'smooth'}), 20);}}>{text.continue} ↗</button></div> : <aside className="settings panel" ref={settingsElement}>
      <div className="setup-heading"><span className="step-badge">01</span><div><h2>{text.setupTitle}</h2><p>{text.setupHelp}</p></div></div>
      <fieldset disabled={busy || loadingMarket}><legend className="sr-only">{text.setupTitle}</legend>
        <label>{text.currency}<select value={config.currency} onChange={event => change('currency', event.target.value as Currency)}><option value="TWD">{text.TWD}</option><option value="USD">{text.USD}</option></select></label><p className="help">{text.currencyHint}</p>
        <div className="input-pair">{moneyInput('initial')}{moneyInput('monthly')}</div>
        <div className="input-pair"><label>{text.start}<input type="date" min="1990-01-01" max="2100-12-31" value={config.start} onChange={event => change('start', event.target.value)} /></label><label>{text.end}<input type="date" min="1990-01-01" max="2100-12-31" value={config.end} onChange={event => change('end', event.target.value)} /></label></div>
        <details className="advanced"><summary>{text.advanced}</summary><div className="input-pair"><label>{text.day}<input type="number" min="1" max="28" value={config.day} onChange={event => change('day', event.target.valueAsNumber)} /></label><label>{text.fees}<input type="number" min="0" max="1000" step="0.1" value={config.feeBps} onChange={event => change('feeBps', event.target.valueAsNumber)} /></label></div><p className="help">{text.dateHint}</p><p className="help">{text.feesHint}</p></details>
        <div className="settings-divider"><span className="step-badge">02</span><h3>{text.selectAssets}</h3></div>
        <label>{text.dataSource}<select value={source} onChange={event => {if (event.target.value === 'market') {if (source === 'imported' && available.every(series => series.source === 'market')) setSource('market'); else loadMarket();} else if (event.target.value === 'demo') showDemo();}}><option value="market">{text.market}</option><option value="demo">{text.demo}</option>{source === 'imported' && <option value="imported">{text.imported}</option>}</select></label><p className="help">{text.fetchHelp}</p>
        <div className="portfolio-list">{config.portfolios.map((portfolio, index) => <div className="portfolio-editor" key={portfolio.id}>
          <div className="portfolio-title"><span className={`number-dot color-${index % 6}`}>{String(index + 1).padStart(2, '0')}</span><input aria-label={`${text.name} ${index + 1}`} maxLength={60} value={portfolio.name} onChange={event => portfolioChange(portfolio.id, {name: event.target.value})} /><button type="button" className="remove" aria-label={`${text.remove} ${portfolio.name}`} onClick={() => change('portfolios', config.portfolios.filter(entry => entry.id !== portfolio.id))}>×</button></div>
          {portfolio.assets.map((asset, assetIndex) => <div key={assetIndex} className="allocation-row"><select aria-label={`${text.symbol} ${index + 1}-${assetIndex + 1}`} value={asset.symbol} onChange={event => selectAsset(portfolio.id, assetIndex, event.target.value)}>{choices.map(series => <option key={series.symbol} value={series.symbol}>{series.symbol} · {series.currency}</option>)}</select><label className="weight-input"><span className="sr-only">{text.weight} {portfolio.name} {assetIndex + 1}</span><input type="number" min="0.01" max="100" step="0.1" value={asset.weight} onChange={event => portfolioChange(portfolio.id, {assets: portfolio.assets.map((entry, entryIndex) => entryIndex === assetIndex ? {...entry, weight: event.target.valueAsNumber} : entry)})} /><span>%</span></label>{portfolio.assets.length > 1 && <button className="remove" aria-label={`${text.remove} ${asset.symbol}`} onClick={() => portfolioChange(portfolio.id, {assets: portfolio.assets.filter((_, entryIndex) => entryIndex !== assetIndex)})}>×</button>}</div>)}
          {portfolio.assets.length < available.filter(series => series.market !== 'FX').length && <button className="text-button small" onClick={() => {const extra = available.find(series => series.market !== 'FX' && !portfolio.assets.some(asset => asset.symbol === series.symbol)); if (extra) portfolioChange(portfolio.id, {assets: [...portfolio.assets.map(asset => ({...asset, weight: asset.weight / 2})), {symbol: extra.symbol, weight: 50}]});}}>+ {text.allocation}</button>}
        </div>)}</div>
        <div className="button-row"><button disabled={config.portfolios.length >= LIMITS.portfolios} onClick={() => {setSearch('');setDialog('add');}}>+ {text.addAsset}</button><button disabled={config.portfolios.length >= LIMITS.portfolios} onClick={addMix}>{text.addMix}</button></div><p className="help">{text.maxPortfolio}</p>
      </fieldset>
      {loadingMarket && <p role="status">{marketProgress || text.loading}</p>}
      <div className="run-actions">{error && dialog !== 'add' && <p className="notice error" id="run-error">{error}</p>}<button className="primary full run-button" aria-describedby={error ? 'run-error' : undefined} onClick={run} disabled={busy || loadingMarket || !config.portfolios.length}>{busy ? text.calculating : text.run}<span>→</span></button>{(busy || loadingMarket) && <button onClick={() => {marketController.current?.abort();runNumber.current++;worker.current?.terminate();worker.current = null;setBusy(false);}}>{text.cancel}</button>}</div>
      <div className="settings-links"><button className="text-button" disabled={busy || loadingMarket} onClick={() => fileInput.current?.click()}>{text.importProject}</button><button className="text-button" disabled={busy || loadingMarket} onClick={showDemo}>{text.reset}</button></div>
    </aside>}
    <div className="results" ref={resultElement} aria-busy={busy}>
      {(busy || loadingMarket) && !completed && <div className="panel loading-state" role="status">{loadingMarket ? <><p>{marketProgress || text.loading}</p><p className="help">{text.fetchHelp}</p></> : text.calculating}</div>}
      {!shared && !busy && !loadingMarket && !completed && <div className="panel loading-state"><h2>{text.dataRequired}</h2><p>{text.dataRequiredHelp}</p><button onClick={() => config.portfolios.length ? run() : loadMarket()}>{text.loadMarket}</button></div>}
      {completed && focused && <>
        <div className="result-heading"><div><p className="eyebrow">THE BIG PICTURE</p><h2>{text.resultTitle}</h2><p>{text.resultSubtitle}</p></div><button className="share-button" disabled={!!dirty || refreshFailed || busy || loadingMarket} onClick={() => setDialog('share')}>↗ {text.share}</button></div>
        <div className={`data-banner${completed.analysis.demo ? ' demo-banner' : ''}`} role="status">{completed.analysis.demo ? text.demoBanner : text.realShort}</div>
        {usedSnapshot!.series.some(series => series.usage === 'research-only') && <p className="notice">{text.researchOnly}</p>}
        {(dirty || refreshFailed || loadingMarket) && !shared && <p className={`notice ${refreshFailed ? 'error' : 'pending'}`} role="status">{refreshFailed ? text.refreshFailed : loadingMarket ? text.updatingResult : text.pending} {text.requestedPeriod}：{config.start} → {config.end}。{text.previousPeriod}：{completed.analysis.start} → {completed.analysis.end}。</p>}
        <div className="result-context"><span>{text.period} <strong>{completed.analysis.start} → {completed.analysis.end}</strong></span><span>{text.contributionCount} <strong>{completed.analysis.contributionCount}</strong></span><span>{text.currency} <strong>{usedSnapshot!.config.currency}</strong></span></div>
        {completed.analysis.end < usedSnapshot!.config.end && <p className="notice">{text.endCoverage} {text.requestedPeriod}：{usedSnapshot!.config.end}；{text.asOf}：{completed.analysis.end}。</p>}
        {dayNumber(completed.analysis.end) - dayNumber(completed.analysis.start) < 365 && <p className="notice">{text.xirrHint}</p>}
        {completed.analysis.shortened && <p className="notice">{text.shortened}</p>}{completed.analysis.sparse && <p className="notice">{text.sparse}</p>}{completed.analysis.sourceMix && <p className="notice">{text.mixedSources}</p>}
        <div className="focus-row"><label>{text.focus}<select value={focused.id} onChange={event => setFocus(event.target.value)}>{completed.analysis.results.map(result => <option key={result.id} value={result.id}>{result.name}</option>)}</select></label><span className="help">{completed.analysis.priceKind === 'total-return' ? text.totalReturn : text.splitAdjusted}</span></div>
        <div className="metrics"><article className="metric main-metric"><span>{text.final}</span><strong>{metric(focused, 'final')}</strong><small>{text.invested} {metric(focused, 'invested')}</small></article><article className="metric"><span>{text.gain}</span><strong className={focused.gain >= 0 ? 'positive' : 'negative'}>{metric(focused, 'gain')}</strong><small>{text.simpleReturn} {metric(focused, 'simpleReturn')}</small></article><article className="metric"><span>{text.xirr}</span><strong>{metric(focused, 'xirr')}</strong><details className="metric-info"><summary>{locale === 'en' ? 'How to read this' : '怎麼解讀？'}</summary><p>{text.xirrHint}</p></details></article><article className="metric"><span>{text.drawdown}</span><strong className="negative">{metric(focused, 'maxDrawdown')}</strong><details className="metric-info"><summary>{locale === 'en' ? 'How to read this' : '怎麼解讀？'}</summary><p>{text.drawdownHint}</p></details></article></div>
        <Suspense fallback={<div className="panel loading-state">{text.loading}</div>}><Chart analysis={completed.analysis} currency={usedSnapshot!.config.currency} locale={locale} /></Suspense>
        <section className="panel comparison"><div className="panel-heading"><h3>{text.compareTitle}</h3><span className="pill">{usedSnapshot!.config.currency}</span></div><p className="help">{text.compareHelp}</p><div className="table-scroll" tabIndex={0} role="region" aria-label={text.compareTitle}><table><thead><tr><th>{text.tableName}</th>{(['final', 'xirr', 'maxDrawdown'] as const).map(key => <th key={key} aria-sort={sort.key === key ? sort.ascending ? 'ascending' : 'descending' : 'none'}><button onClick={() => setSort({key, ascending: sort.key === key ? !sort.ascending : false})}>{key === 'maxDrawdown' ? text.drawdown : text[key]} {sort.key === key ? sort.ascending ? '↑' : '↓' : '↕'}</button></th>)}<th>{text.twr}</th></tr></thead><tbody>{sorted!.map(result => <tr key={result.id} className={focus === result.id ? 'focused-row' : ''}><th><button onClick={() => setFocus(result.id)}>{result.name}</button></th><td>{metric(result, 'final')}</td><td>{metric(result, 'xirr')}</td><td className="negative">{metric(result, 'maxDrawdown')}</td><td>{metric(result, 'twr')}</td></tr>)}</tbody></table></div></section>
        <details className="panel details-panel"><summary>{text.yearlyTitle} · {focused.name}</summary><p className="help">{text.yearlyHelp}</p><div className="year-grid">{focused.yearly.map(year => <div key={year.year}><span>{year.year}</span><strong className={year.return >= 0 ? 'positive' : 'negative'}>{percent(year.return, locale)}</strong><div className="year-bar" style={{width: `${Math.min(100, Math.abs(year.return) * 100)}%`, backgroundColor: year.return >= 0 ? '#87b09b' : '#d2a396'}} /></div>)}</div></details>
        <details className="panel details-panel"><summary>{text.dataDetails}</summary><p>{text.assumptions}</p><p>{text.fees}：{usedSnapshot!.config.feeBps} bps · {text.day}：{usedSnapshot!.config.day}</p><p className="help">{text.dateHint}</p><div className="table-scroll" tabIndex={0}><table><thead><tr><th>{text.symbol}</th><th>{text.source}</th><th>{text.coverage}</th><th>{text.rows}</th></tr></thead><tbody>{usedSnapshot!.series.map(series => <tr key={series.symbol}><th>{series.symbol}<small>{series.currency} · {series.priceKind}</small></th><td>{series.sourceName}<small>{series.source === 'demo' ? text.demoShort : series.source === 'import' ? text.imported : text.market}</small></td><td>{series.rows[0][0]}<br />{series.rows.at(-1)![0]}</td><td>{series.rows.length}</td></tr>)}</tbody></table></div>{dayNumber(new Date().toISOString().slice(0, 10)) - dayNumber(completed.analysis.end) > 10 && <p className="notice">{text.staleData}</p>}<a href={`/${locale}/methodology/`}>{text.methodology} →</a></details>
        <div className="export-actions"><button onClick={() => download('steadyfolio-analysis.json', JSON.stringify(usedSnapshot), 'application/json')}>{text.exportProject}</button><button onClick={exportDaily}>{text.exportCsv}</button><button onClick={() => window.print()}>{text.print}</button><button onClick={() => receiptInput.current?.click()}>{text.manageShare}</button></div><p className="help">{text.fileHelp}</p><p className="report-disclaimer">{text.footerNote}</p>
      </>}
    </div>
    {dialog === 'add' && <Dialog title={text.addAsset} locale={locale} onClose={() => {marketController.current?.abort();setDialog(null);}}><form onSubmit={event => {event.preventDefault();if (source === 'market' && search.trim() && !loadingMarket) addAsset({symbol: search});}}><label>{text.search}<input type="search" autoFocus maxLength={24} value={search} placeholder="0050 / 2330.TW / 6488.TWO / AAPL" onChange={event => setSearch(event.target.value)} /></label>{source === 'market' && <><p className="help">{text.symbolHelp}</p><button type="submit" disabled={loadingMarket || !search.trim()}>{text.fetchSymbol}</button></>}</form><div className="asset-picker">{choices.filter(series => `${series.symbol} ${series.name}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(series => <button key={series.symbol} disabled={loadingMarket} onClick={() => addAsset(series)}><strong>{series.symbol}</strong><span>{series.name}</span><small>{series.currency} · {series.source === 'demo' ? text.demo : series.source === 'import' ? text.imported : text.market}</small><b>+</b></button>)}</div><p className="help" role="status">{loadingMarket ? marketProgress : text.noMatches}</p>{error && <p role="alert" className="notice error">{error}</p>}</Dialog>}
    {dialog === 'share' && usedSnapshot && <Share snapshot={usedSnapshot} locale={locale} onClose={() => setDialog(null)} />}
    {manageReceipt && <Dialog title={text.deleteShare} locale={locale} onClose={() => setManageReceipt(null)}><p>{manageReceipt.url}</p><p>{text.deleteHelp}</p><button className="danger" onClick={revokeReceipt}>{text.deleteShare}</button></Dialog>}
    {error && !dialog && !manageReceipt && <Dialog title={text.errorTitle} locale={locale} onClose={() => setError('')}><p className="notice error" role="alert">{error}</p>{refreshFailed && completed && <p>{text.refreshFailed} {text.previousPeriod}：{completed.analysis.start} → {completed.analysis.end}</p>}<button className="primary full" onClick={() => setError('')}>{text.close}</button></Dialog>}
  </section>;
}
