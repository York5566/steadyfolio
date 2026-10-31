export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

export async function readJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED');
  if (request.headers.has('content-encoding')) throw new ApiError(415, 'ENCODING_NOT_SUPPORTED');
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ApiError(413, 'TOO_LARGE');
  if (!request.body) throw new ApiError(400, 'INVALID_INPUT');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, 'TOO_LARGE'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_JSON'); }
}

export function randomToken(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(part => part.toString(16).padStart(2, '0')).join('');
}

export function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export const isLocal = (request: Request, environment: string) => environment === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
