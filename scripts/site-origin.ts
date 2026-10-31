export function productionOrigin(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) return null;
    if (!host.includes('.') || /(?:^|\.)(localhost|example|invalid|test|local)$/.test(host) || /^(?:.*\.)?example\.(com|org|net)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return url.origin;
  } catch { return null; }
}
