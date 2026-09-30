'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../../i18n/client.ts';

export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
export interface TurnstileAPI {
  render(container: HTMLElement, options: { sitekey: string; size: 'flexible' | 'compact'; theme: 'auto'; language: string;
    callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void }): string;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: TurnstileAPI } }

let loading: Promise<TurnstileAPI> | undefined;
function load(): Promise<TurnstileAPI> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return loading ??= new Promise<TurnstileAPI>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable'));
    script.onerror = () => { loading = undefined; script.remove(); reject(new Error('Turnstile unavailable')); };
    document.head.append(script);
  });
}

/** Each attempt uses a fresh token. Expiry and provider failures clear it so a
 * stale challenge cannot be sent. Strict Mode/unmount remove their widget. */
export function Turnstile({ siteKey, attempt, onToken, onError }: { siteKey?: string; attempt: number;
  onToken(token: string | undefined): void; onError?(): void }) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<'flexible' | 'compact'>('flexible');
  const locale = useLocale().current;
  const language = locale === 'zh-Hans' ? 'zh-cn' : locale === 'zh-Hant' ? 'zh-tw' : locale;
  const callbacks = useRef({ onToken, onError });
  callbacks.current = { onToken, onError };
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    // Cloudflare's flexible widget has a 300px minimum. Compact mode keeps
    // narrow phones usable without clipping the challenge or its controls.
    const measure = () => setSize(node.clientWidth < 300 ? 'compact' : 'flexible');
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    let id: string | undefined;
    let api: TurnstileAPI | undefined;
    callbacks.current.onToken(undefined);
    const key = siteKey ?? (['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
      ? TURNSTILE_TEST_SITE_KEY : undefined);
    if (!key) { callbacks.current.onError?.(); return; }
    void load().then(loaded => {
      if (disposed || !container.current) return;
      api = loaded;
      id = api.render(container.current, { sitekey: key, size, theme: 'auto', language,
        callback: token => { if (!disposed) callbacks.current.onToken(token); },
        'expired-callback': () => { if (!disposed) callbacks.current.onToken(undefined); },
        'error-callback': () => { if (!disposed) { callbacks.current.onToken(undefined); callbacks.current.onError?.(); } },
      });
    }).catch(() => { if (!disposed) callbacks.current.onError?.(); });
    return () => { disposed = true; if (id !== undefined) api?.remove(id); };
  }, [siteKey, attempt, size, language]);
  return <div ref={container} className="w-full min-w-0" />;
}
