import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export type VerificationConfig = { sitekey: string; scriptUrl: string };
type Turnstile = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      language: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  reset(id: string): void;
  remove(id: string): void;
};

type ScriptEntry = {
  url: string;
  element: HTMLScriptElement;
  promise: Promise<Turnstile>;
  resolve: (api: Turnstile) => void;
  reject: (error: Error) => void;
  consumers: number;
  settled: boolean;
  cancelQueued: boolean;
};

type ScriptLease = { promise: Promise<Turnstile>; release: () => void };
const inFlight = new Map<string, ScriptEntry>();
let lastLoaded: { url: string; api: Turnstile } | undefined;
const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function removeEntry(entry: ScriptEntry) {
  if (inFlight.get(entry.url) === entry) inFlight.delete(entry.url);
  entry.element.onload = null;
  entry.element.onerror = null;
  entry.element.remove();
}

function acquireScript(url: string): ScriptLease {
  let entry = inFlight.get(url);
  if (!entry && lastLoaded?.url === url) {
    return { promise: Promise.resolve(lastLoaded.api), release: () => {} };
  }

  if (!entry) {
    // Drop abandoned loads when configuration changes; a live widget keeps its own bounded lease.
    for (const [priorUrl, prior] of inFlight) {
      if (prior.consumers === 0) {
        removeEntry(prior);
        inFlight.delete(priorUrl);
      }
    }

    const element = document.createElement('script');
    element.async = true;
    element.src = url;
    let resolve!: (api: Turnstile) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Turnstile>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    entry = { url, element, promise, resolve, reject, consumers: 0, settled: false, cancelQueued: false };
    inFlight.set(url, entry);
    element.onload = () => {
      if (inFlight.get(url) !== entry || entry!.settled) return;
      const api = (window as Window & { turnstile?: Turnstile }).turnstile;
      if (!api) {
        entry!.settled = true;
        entry!.reject(new Error('Verification unavailable'));
        if (entry!.consumers === 0) removeEntry(entry!);
        return;
      }
      entry!.settled = true;
      lastLoaded = { url, api };
      entry!.resolve(api);
      if (entry!.consumers === 0) removeEntry(entry!);
    };
    element.onerror = () => {
      if (inFlight.get(url) !== entry || entry!.settled) return;
      entry!.settled = true;
      entry!.reject(new Error('Verification unavailable'));
      if (entry!.consumers === 0) removeEntry(entry!);
    };
    document.head.appendChild(element);
  }

  entry.consumers += 1;
  entry.cancelQueued = false;
  let released = false;
  return {
    promise: entry.promise,
    release() {
      if (released) return;
      released = true;
      entry!.consumers = Math.max(0, entry!.consumers - 1);
      if (entry!.consumers !== 0 || entry!.cancelQueued) return;
      entry!.cancelQueued = true;
      queueMicrotask(() => {
        if (entry!.consumers !== 0) {
          entry!.cancelQueued = false;
          return;
        }
        if (entry!.settled) {
          removeEntry(entry!);
          return;
        }
        entry!.settled = true;
        removeEntry(entry!);
        entry!.reject(new Error('Verification unavailable'));
      });
    },
  };
}

type VerificationCallbacks = {
  onToken: (token: string) => void;
  onStart: () => void;
};

// Dialog content mounts lazily. No challenge script or widget exists before opening it.
export function Verification({
  config,
  locale,
  onToken,
  reset,
  onStart,
}: {
  config: VerificationConfig;
  locale: string;
  onToken: (token: string) => void;
  reset: RefObject<(() => void) | null>;
  onStart: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef<VerificationCallbacks>({ onToken, onStart });
  const configKey = JSON.stringify([config.sitekey, config.scriptUrl, locale]);
  const latestConfigKey = useRef(configKey);
  latestConfigKey.current = configKey;
  const activeWidget = useRef<object | null>(null);

  useClientLayoutEffect(() => {
    callbacks.current = { onToken, onStart };
  }, [onStart, onToken]);

  useClientLayoutEffect(() => {
    const widget = {};
    activeWidget.current = widget;
    let live = true;
    let api: Turnstile | undefined;
    let widgetId: string | undefined;
    const lease = acquireScript(config.scriptUrl);
    const current = () =>
      live && activeWidget.current === widget && latestConfigKey.current === configKey && reset.current === resetWidget;
    const publishToken = (next: string) => {
      if (current()) callbacks.current.onToken(next);
    };
    const resetWidget = () => {
      if (!current() || !api || !widgetId) return;
      publishToken('');
      api.reset(widgetId);
    };

    reset.current = resetWidget;
    callbacks.current.onStart();
    publishToken('');

    void lease.promise
      .then((loadedApi) => {
        if (!current() || !container.current) return;
        api = loadedApi;
        const id = api.render(container.current, {
          sitekey: config.sitekey,
          language: locale,
          callback: (next) => publishToken(next),
          'expired-callback': () => publishToken(''),
          'error-callback': () => publishToken(''),
        });
        widgetId = id;
      })
      .catch(() => {
        publishToken('');
      });

    return () => {
      const owned = activeWidget.current === widget;
      live = false;
      if (owned) {
        activeWidget.current = null;
        if (reset.current === resetWidget) {
          reset.current = null;
          callbacks.current.onToken('');
        }
      }
      if (api && widgetId) api.remove(widgetId);
      lease.release();
    };
  }, [config.scriptUrl, config.sitekey, configKey, locale, reset]);

  return <div ref={container} />;
}
