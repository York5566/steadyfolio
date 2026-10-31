import { useEffect, useRef, type ReactNode } from 'react';
import { messages, type Locale } from '../i18n';

export function Dialog({title, locale, onClose, children}: {title: string; locale: Locale; onClose: () => void; children: ReactNode}) {
  const element = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = element.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={element} onCancel={onClose} aria-labelledby="dialog-title"><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label={messages[locale].close}>×</button></div><div className="dialog-content">{children}</div></dialog>;
}
