import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

type TurnstileRenderOptions = {
  sitekey: string;
  action: 'signup';
  language: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
};

type TurnstileApi = {
  ready: (callback: () => void) => void;
  render: (element: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

type TurnstileScript = { src: string; promise: Promise<void> };

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __authTurnstile?: TurnstileScript;
  }
}

export type TurnstileHandle = {
  reset: () => void;
};

// One explicit widget. The script is inserted once per page, even if the effect runs twice.
export function loadTurnstile(src: string): Promise<void> {
  const current = window.__authTurnstile;
  if (current?.src === src) return current.promise;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Turnstile failed to load'));
    document.head.appendChild(script);
  });
  window.__authTurnstile = { src, promise };
  return promise;
}

export const TurnstileWidget = forwardRef<
  TurnstileHandle,
  {
    siteKey: string;
    scriptUrl: string;
    language: string;
    onToken: (token: string | null) => void;
  }
>(function TurnstileWidget({ siteKey, scriptUrl, language, onToken }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useImperativeHandle(ref, () => ({
    reset() {
      onTokenRef.current(null);
      const id = widgetId.current;
      if (id) window.turnstile?.reset(id);
    },
  }));

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    let cancelled = false;
    loadTurnstile(scriptUrl)
      .then(() => {
        if (cancelled || !window.turnstile || widgetId.current) return;
        const render = () => {
          if (cancelled || !window.turnstile || widgetId.current) return;
          widgetId.current = window.turnstile.render(element, {
            sitekey: siteKey,
            action: 'signup',
            language,
            callback: (token) => onTokenRef.current(token),
            'expired-callback': () => onTokenRef.current(null),
            'error-callback': () => onTokenRef.current(null),
          });
        };
        window.turnstile.ready(render);
      })
      .catch(() => {
        if (!cancelled) onTokenRef.current(null);
      });
    return () => {
      cancelled = true;
      const id = widgetId.current;
      widgetId.current = null;
      if (id) window.turnstile?.remove(id);
    };
  }, [language, scriptUrl, siteKey]);

  return <div ref={container} className="auth-signup-turnstile" />;
});
