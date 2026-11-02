import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

type TurnstileRenderOptions = {
  sitekey: string;
  action: 'signup';
  language: string;
  retry: 'never';
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

type ScriptAcquisition = {
  promise: Promise<void>;
  api?: TurnstileApi;
  owners: number;
  settled: boolean;
  abandon: () => void;
};

const acquisitions = new Map<string, ScriptAcquisition>();
const acquisitionTimeout = 15_000;

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function acquireScript(src: string): ScriptAcquisition {
  const shared = acquisitions.get(src);
  if (shared) return shared;
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  let finish!: (error?: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error) {
        if (acquisitions.get(src) === entry) acquisitions.delete(src);
        script.remove();
        reject(error);
      } else {
        entry.api = window.turnstile!;
        resolve();
      }
    };
  });
  const entry: ScriptAcquisition = {
    promise,
    owners: 0,
    settled: false,
    abandon: () => {
      if (!entry.settled) finish(new Error('Turnstile acquisition retired'));
      else {
        if (acquisitions.get(src) === entry) acquisitions.delete(src);
        script.remove();
      }
    },
  };
  const timer = setTimeout(() => finish(new Error('Turnstile loading timed out')), acquisitionTimeout);
  script.onload = () => {
    const api = window.turnstile;
    const available =
      api &&
      ['ready', 'render', 'reset', 'remove'].every((name) => typeof api[name as keyof TurnstileApi] === 'function');
    finish(available ? undefined : new Error('Turnstile API missing'));
  };
  script.onerror = () => finish(new Error('Turnstile failed to load'));
  acquisitions.set(src, entry);
  try {
    document.head.appendChild(script);
  } catch {
    finish(new Error('Turnstile script could not be inserted'));
  }
  return entry;
}

// Share healthy same-source acquisitions, but never retain a rejected promise.
export function loadTurnstile(src: string): Promise<void> {
  return acquireScript(src).promise;
}

export type TurnstileStatus = 'loading' | 'ready' | 'failed';
export type TurnstileHandle = {
  getToken: () => string | null;
  reset: () => void;
  retry: () => void;
};

type Generation = {
  token: string | null;
  phase: 'loading' | 'rendering' | 'active' | 'failed' | 'retired';
  retire: () => void;
};

export const TurnstileWidget = forwardRef<
  TurnstileHandle,
  {
    siteKey: string;
    scriptUrl: string;
    language: string;
    onToken: (token: string | null) => void;
    onStatus?: (status: TurnstileStatus) => void;
  }
>(function TurnstileWidget({ siteKey, scriptUrl, language, onToken, onStatus }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const generation = useRef<Generation | null>(null);
  const callbacks = useRef({ onToken, onStatus });
  callbacks.current = { onToken, onStatus };
  const [attempt, setAttempt] = useState(0);
  const resetOnRender = useRef(false);

  useLayoutEffect(() => {
    const host = container.current;
    if (!host) return;
    // A generation owns its own DOM and captured API, including a late render result.
    const element = document.createElement('div');
    host.appendChild(element);
    let api: TurnstileApi | undefined;
    let id: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current: Generation = {
      token: null,
      phase: 'loading',
      retire() {
        current.phase = 'retired';
        current.token = null;
        clearTimeout(timer);
        remove();
      },
    };
    generation.current = current;
    const isLive = () => generation.current === current && current.phase !== 'retired' && current.phase !== 'failed';
    const removeId = (ownedId: string) => {
      try {
        api?.remove(ownedId);
      } catch {
        // DOM and timer cleanup must still run when the provider refuses removal.
      }
    };
    function remove() {
      const ownedId = id;
      id = undefined;
      if (ownedId !== undefined) removeId(ownedId);
      element.remove();
    }
    const fail = () => {
      if (!isLive()) return;
      current.phase = 'failed';
      current.token = null;
      clearTimeout(timer);
      remove();
      if (generation.current !== current || current.phase !== 'failed') return;
      callbacks.current.onToken(null);
      if (generation.current === current && current.phase === 'failed') callbacks.current.onStatus?.('failed');
    };
    const publish = (token: string | null) => {
      if (!isLive()) return;
      current.token = token;
      // render/reset may call back synchronously and then throw. Publish only after both return.
      if (current.phase === 'active') callbacks.current.onToken(token);
    };
    callbacks.current.onToken(null);
    callbacks.current.onStatus?.('loading');
    const reset = resetOnRender.current;
    resetOnRender.current = false;
    const script = acquireScript(scriptUrl);
    script.owners++;
    script.promise.then(() => {
      if (!isLive()) return;
      const loadedApi = script.api!;
      api = loadedApi;
      timer = setTimeout(fail, acquisitionTimeout);
      let readyReturned = false;
      let rendered = false;
      const activate = () => {
        if (!isLive() || !readyReturned || !rendered) return;
        current.phase = 'active';
        clearTimeout(timer);
        callbacks.current.onStatus?.('ready');
        if (isLive()) callbacks.current.onToken(current.token);
      };
      try {
        api.ready(() => {
          if (!isLive() || current.phase !== 'loading') return;
          current.phase = 'rendering';
          try {
            const renderedId = loadedApi.render(element, {
              sitekey: siteKey,
              action: 'signup',
              language,
              retry: 'never',
              callback: (token) => publish(token || null),
              'expired-callback': () => publish(null),
              'error-callback': fail,
            });
            if (!isLive()) {
              removeId(renderedId);
              return;
            }
            id = renderedId;
            if (reset) loadedApi.reset(renderedId);
            if (!isLive()) return;
            rendered = true;
            activate();
          } catch {
            fail();
          }
        });
        readyReturned = true;
        activate();
      } catch {
        fail();
      }
    }, fail);
    return () => {
      current.retire();
      if (generation.current === current) generation.current = null;
      script.owners--;
      // StrictMode's immediate second setup keeps the single pending acquisition.
      queueMicrotask(() => {
        if (!script.owners) script.abandon();
      });
    };
  }, [language, scriptUrl, siteKey, attempt]);

  useImperativeHandle(ref, () => {
    const current = generation.current;
    const restart = (reset: boolean) => {
      if (!current || generation.current !== current || current.phase === 'retired') return;
      current.retire();
      if (generation.current !== current) return;
      callbacks.current.onToken(null);
      callbacks.current.onStatus?.('loading');
      resetOnRender.current = reset;
      setAttempt((value) => value + 1);
    };
    return {
      getToken: () => (current?.phase === 'active' ? current.token : null),
      reset: () => restart(true),
      retry: () => restart(false),
    };
  }, [language, scriptUrl, siteKey, attempt]);

  return <div ref={container} className="auth-signup-turnstile" />;
});
