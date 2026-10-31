import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, AriaComponent, TitleComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Analysis } from '../core/engine';
import { messages, money, percent, type Locale } from '../i18n';
import type { Currency } from '../core/schema';
import { download } from '../api';

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, AriaComponent, TitleComponent, LegendComponent, CanvasRenderer]);
export const colors = ['#26705c', '#6389bc', '#cd8851', '#9465ad', '#b65e6e', '#7e9146', '#4b99a8', '#83614a', '#486b9b', '#a6963a', '#6d807e', '#5e56ae'];
type View = 'value' | 'gain' | 'nav' | 'drawdown';

export function Chart({analysis, currency, locale}: {analysis: Analysis; currency: Currency; locale: Locale}) {
  const text = messages[locale];
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.EChartsType | null>(null);
  const [view, setView] = useState<View>('value');
  const [visible, setVisible] = useState(analysis.results.map(result => result.id));
  const [range, setRange] = useState(0);
  useEffect(() => { setVisible(analysis.results.map(result => result.id)); setRange(0); }, [analysis]);
  useEffect(() => {
    if (!element.current) return;
    const instance = echarts.init(element.current, undefined, {renderer: 'canvas'});
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); instance.dispose(); chart.current = null; };
  }, []);
  useEffect(() => {
    if (!chart.current) return;
    const results = analysis.results.filter(result => visible.includes(result.id));
    const dates = analysis.results[0].points.map(point => point.date);
    const rangeDate = new Date(`${dates.at(-1)}T00:00:00Z`);
    rangeDate.setUTCFullYear(rangeDate.getUTCFullYear() - range);
    const startIndex = range ? Math.max(0, dates.findIndex(date => date >= rangeDate.toISOString().slice(0, 10))) : 0;
    const currencyView = view === 'value' || view === 'gain';
    const series: Record<string, unknown>[] = results.map(result => ({
      type: 'line', name: result.name, showSymbol: false, sampling: 'lttb',
      lineStyle: {width: 2.5, type: analysis.results.findIndex(entry => entry.id === result.id) >= 6 ? 'dashed' : 'solid'},
      itemStyle: {color: colors[analysis.results.findIndex(entry => entry.id === result.id) % colors.length]},
      data: result.points.map(point => view === 'gain' ? point.value - point.invested : view === 'drawdown' ? point.drawdown * 100 : point[view]),
    }));
    if (view === 'value') series.push({type: 'line', name: text.invested, showSymbol: false, lineStyle: {type: 'dashed', width: 1.5, color: '#999e96'}, itemStyle: {color: '#999e96'}, data: analysis.results[0].points.map(point => point.invested)});
    chart.current.setOption({
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      backgroundColor: '#ffffff',
      title: {text: analysis.demo ? text.demoShort : `${text.period} ${analysis.start} – ${analysis.end}`, left: 'center', top: 10, textStyle: {fontSize: 11, fontWeight: 'normal', color: '#71796f'}},
      aria: {enabled: true, label: {description: `${text.chartTitle}. ${analysis.demo ? text.demoShort : text.realShort}. ${analysis.start} – ${analysis.end}. ${currency}. ${text.compareHelp}`}, decal: {show: true}},
      grid: {left: 14, right: 25, top: 60, bottom: 82, containLabel: true},
      tooltip: {trigger: 'axis', renderMode: 'richText', confine: true, valueFormatter: (value: unknown) => typeof value !== 'number' ? '—' : currencyView ? money(value, currency, locale) : view === 'drawdown' ? percent(value / 100, locale) : value.toFixed(2)},
      xAxis: {type: 'category', data: dates, boundaryGap: false, axisLine: {lineStyle: {color: '#d8dfd6'}}, axisLabel: {color: '#697567', hideOverlap: true, formatter: (value: string) => value.slice(0, 7)}, axisTick: {show: false}},
      yAxis: {type: 'value', name: currencyView ? currency : view === 'drawdown' ? '%' : 'NAV', nameTextStyle: {color: '#697567'}, axisLabel: {color: '#697567', formatter: (value: number) => currencyView ? new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-TW', {notation: 'compact', maximumFractionDigits: 1}).format(value) : value}, splitLine: {lineStyle: {color: '#edf0eb', type: 'dashed'}}},
      dataZoom: [{type: 'slider', startValue: startIndex, endValue: dates.length - 1, bottom: 14, height: 24, borderColor: '#dbe3d8', fillerColor: '#dfeadd', handleStyle: {color: '#26705c'}, brushSelect: false}, {type: 'inside', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, preventDefaultMouseMove: false}],
      series,
    }, true);
  }, [analysis, currency, locale, range, text, view, visible]);
  function downloadChart() {
    if (!chart.current) return;
    const exported = echarts.init(document.createElement('div'), undefined, {width: 1440, height: 900, renderer: 'canvas'});
    try {
      const options = chart.current.getOption();
      const series = (options.series as Record<string, unknown>[]).map((entry, index) => ({...entry, name: `${index + 1}. ${entry.name}`}));
      exported.setOption({...options, animation: false, series,
        title: {text: text.chartTitle, subtext: `${analysis.demo ? text.demoShort : text.realShort} · ${analysis.start} – ${analysis.end} · ${currency}`, left: 'center', top: 14},
        legend: {selectedMode: false, top: 75, left: 25, right: 25, data: series.map(entry => entry.name), formatter: (name: string) => name.length > 36 ? name.slice(0, 35) + '…' : name},
        grid: {left: 35, right: 35, top: 170, bottom: 90, containLabel: true},
      });
      const dataUrl = exported.getDataURL({type: 'png', pixelRatio: 1, backgroundColor: '#fff'});
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
      download(`steadyfolio-${analysis.demo ? 'synthetic-demo-' : ''}${view}.png`, bytes, 'image/png');
    } finally {exported.dispose();}
  }
  return <section className="panel chart-panel" aria-label={text.chartTitle}>
    <div className="panel-heading"><h3>{text.chartTitle}</h3><button className="icon-button" onClick={downloadChart} title={text.downloadChart} aria-label={text.downloadChart}>↓</button></div>
    <div className="chart-toolbar"><div className="segmented" aria-label={text.chartTitle}>{(['value', 'gain', 'nav', 'drawdown'] as View[]).map(mode => <button key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{text[`${mode}View` as 'valueView']}</button>)}</div>
      <select aria-label={text.resetZoom} value={range} onChange={event => setRange(Number(event.target.value))}><option value={0}>{text.all}</option><option value={1}>{text.years1}</option><option value={3}>{text.years3}</option><option value={5}>{text.years5}</option></select>
    </div>
    <div className="chart-legend">{analysis.results.map((result, index) => <label key={result.id} style={{'--series': colors[index % colors.length]} as React.CSSProperties}><input type="checkbox" checked={visible.includes(result.id)} onChange={event => setVisible(current => event.target.checked ? [...current, result.id] : current.length > 1 ? current.filter(id => id !== result.id) : current)} /><span>{index + 1}. {result.name}</span></label>)}{view === 'value' && <span className="principal-key">┄ {text.invested}</span>}</div>
    <div ref={element} className="chart" role="img" aria-label={`${text.chartTitle}. ${analysis.demo ? text.demoShort : text.realShort}`} />
    <div className="chart-foot"><p>{text.chartHelp}</p><button className="text-button" onClick={() => {setRange(0); chart.current?.dispatchAction({type: 'dataZoom', start: 0, end: 100});}}>{text.resetZoom}</button></div>
  </section>;
}
