import { api } from './api';
import { marketSymbol, type HistoryReply } from './core/market';
import { isoDate, seriesSchema } from './core/schema';

function pause(signal: AbortSignal, delay: number) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {clearTimeout(timer); reject(signal.reason);};
    const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, delay);
    signal.addEventListener('abort', abort, {once: true});
  });
}

export async function loadHistory(input: string, start: string, end: string, signal: AbortSignal, progress: (symbol: string, completed?: number, total?: number) => void) {
  const symbol = marketSymbol(input);
  isoDate.parse(start); isoDate.parse(end);
  if (start >= end) throw new Error('INVALID_PERIOD');
  progress(symbol);
  for (let attempt = 0; attempt < 240; attempt++) {
    signal.throwIfAborted();
    const result = await api<HistoryReply>(`/api/history/${symbol}/${start}/${end}`, {signal}, 40000);
    signal.throwIfAborted();
    if ('series' in result) {
      const series = seriesSchema.parse(result.series);
      if (series.symbol !== symbol || series.source !== 'market') throw new Error('PROVIDER_DATA_INVALID');
      return series;
    }
    if (!result.pending) throw new Error('PROVIDER_DATA_INVALID');
    progress(symbol, result.completed, result.total);
    await pause(signal, result.total ? 2100 : 5000);
  }
  throw new Error('PROVIDER_UNAVAILABLE');
}
