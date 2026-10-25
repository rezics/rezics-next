import { useEffect, useRef, type RefObject } from 'react';

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
let script: Promise<Turnstile> | undefined;
function loadScript(url: string): Promise<Turnstile> {
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const element = document.createElement('script');
    element.src = url;
    element.async = true;
    element.onload = () => {
      const api = (window as Window & { turnstile?: Turnstile }).turnstile;
      if (api) resolve(api);
      else reject(new Error('Verification unavailable'));
    };
    element.onerror = () => reject(new Error('Verification unavailable'));
    document.head.appendChild(element);
  });
  return script;
}

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
  useEffect(() => {
    let live = true;
    let dispose: (() => void) | undefined;
    onStart();
    onToken('');
    void loadScript(config.scriptUrl)
      .then((api) => {
        if (!live || !container.current) return;
        const id = api.render(container.current, {
          sitekey: config.sitekey,
          language: locale,
          callback: (token) => {
            if (live) onToken(token);
          },
          'expired-callback': () => {
            if (live) onToken('');
          },
          'error-callback': () => {
            if (live) onToken('');
          },
        });
        reset.current = () => {
          onToken('');
          api.reset(id);
        };
        dispose = () => api.remove(id);
      })
      .catch(() => {
        if (live) onToken('');
      });
    return () => {
      live = false;
      reset.current = null;
      onToken('');
      dispose?.();
    };
  }, [config.sitekey, config.scriptUrl, locale, onToken, onStart, reset]);
  return <div ref={container} />;
}
