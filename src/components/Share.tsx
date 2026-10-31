import { useEffect, useRef, useState } from 'react';
import { api, download } from '../api';
import { LIMITS, problemCode, type Snapshot } from '../core/schema';
import { errorText, intlLocale, messages, type Locale } from '../i18n';
import { Dialog } from './Dialog';

type Turnstile = {render: (element: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void; reset: (id: string) => void};
declare global { interface Window { turnstile?: Turnstile } }
export type Receipt = {id: string; deleteToken: string; expiresAt: string; url: string; apiOrigin: string; schema: 1};
type ApiConfig = {sharingEnabled: boolean; siteKey: string; localDevelopment: boolean};

export function Share({snapshot, locale, onClose}: {snapshot: Snapshot; locale: Locale; onClose: () => void}) {
  const text = messages[locale];
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  useEffect(() => { api<ApiConfig>('/api/config').then(setConfig).catch(() => setError(text.shareUnavailable)); }, [text]);
  useEffect(() => {
    if (!config?.sharingEnabled || !consent) return;
    if (config.localDevelopment) { setToken('local-development'); return; }
    let active = true;
    function render() {
      if (!active || !container.current || !window.turnstile) return;
      widget.current = window.turnstile.render(container.current, {sitekey: config!.siteKey, action: 'share', language: locale === 'en' ? 'en' : 'zh-tw', callback: (value: string) => setToken(value), 'expired-callback': () => setToken(''), 'error-callback': () => {setToken(''); setError(errorText('VERIFICATION_FAILED', locale));}});
    }
    if (window.turnstile) render();
    else {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = render;
      script.onerror = () => { if (active) setError(text.shareUnavailable); };
      document.head.appendChild(script);
    }
    return () => {active = false; if (widget.current && window.turnstile) window.turnstile.remove(widget.current); widget.current = null; setToken('');};
  }, [config, consent, locale, text]);
  async function create() {
    setBusy(true); setError('');
    try {
      if (new TextEncoder().encode(JSON.stringify(snapshot)).length > LIMITS.shareBytes) throw new Error('TOO_LARGE');
      const result = await api<{id: string; deleteToken: string; expiresAt: string}>('/api/shares', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({snapshot, token})});
      const next: Receipt = {...result, schema: 1, url: `${location.origin}/${locale}/share/#${result.id}`, apiOrigin: import.meta.env.VITE_API_BASE || location.origin};
      setReceipt(next);
      try { sessionStorage.setItem(`steadyfolio-share-${result.id}`, JSON.stringify(next)); } catch { setError(text.deleteHelp); }
    } catch (error) {setError(errorText(problemCode(error), locale));}
    finally {setBusy(false); setToken(config?.localDevelopment ? 'local-development' : ''); if (widget.current) window.turnstile?.reset(widget.current);}
  }
  async function revoke() {
    if (!receipt) return;
    setBusy(true); setError('');
    try { await api(`/api/shares/${receipt.id}`, {method: 'DELETE', headers: {Authorization: `Bearer ${receipt.deleteToken}`}}); setDeleted(true); sessionStorage.removeItem(`steadyfolio-share-${receipt.id}`); }
    catch (error) {setError(errorText(problemCode(error), locale));}
    finally {setBusy(false);}
  }
  return <Dialog title={text.share} locale={locale} onClose={onClose}>
    {deleted ? <p role="status" className="notice success">{text.deleted}</p> : receipt ? <>
      <p className="notice success">{text.shareReady}</p><label>{text.shareReady}<input readOnly value={receipt.url} onFocus={event => event.target.select()} /></label>
      <p>{text.expires}：{new Date(receipt.expiresAt).toLocaleString(intlLocale(locale))}</p>
      <div className="button-row"><button className="primary" onClick={async () => {try {await navigator.clipboard.writeText(receipt.url);setCopied(true);} catch {setCopied(false);}}}>{copied ? text.copied : text.copy}</button><button onClick={() => download('steadyfolio-share-management.json', JSON.stringify(receipt, null, 2), 'application/json')}>{text.receipt}</button></div>
      <p className="help">{text.deleteHelp}</p><button className="danger" onClick={revoke} disabled={busy}>{text.deleteShare}</button>
    </> : <>
      <p>{text.shareIntro}</p><p className="help">{text.fileHelp}</p>
      {config && !config.sharingEnabled && <p className="notice">{text.shareUnavailable}</p>}
      <label className="checkbox"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{text.shareConsent}</label>
      <div ref={container} />
      <button className="primary full" onClick={create} disabled={busy || !config?.sharingEnabled || !consent || !token}>{busy ? text.loading : text.createLink}</button>
    </>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </Dialog>;
}
