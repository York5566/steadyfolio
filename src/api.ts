const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
export async function api<T>(path: string, options: RequestInit = {}, timeout = 15000): Promise<T> {
  let response: Response;
  try { response = await fetch(`${base}${path}`, {...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)}); }
  catch { throw new Error('SERVICE_UNAVAILABLE'); }
  const body = await response.json().catch(() => ({error: 'SERVICE_UNAVAILABLE'})) as {error?: string};
  if (!response.ok) throw new Error(body.error ?? 'SERVICE_UNAVAILABLE');
  return body as T;
}
export function download(name: string, content: BlobPart, type: string) {
  const href = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}
