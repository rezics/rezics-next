import { useCallback, useLayoutEffect, useRef, type MouseEvent } from 'react';

/** One mounted consent transition owns its keyboard orientation until the reader moves. */
export function useConsentFocus() {
  const pending = useRef<{
    source: HTMLButtonElement;
    current: () => boolean;
    ready: () => boolean;
    target: () => HTMLElement | null | undefined;
    dispose: () => void;
  } | null>(null);
  const cancel = useCallback(() => {
    pending.current?.dispose();
    pending.current = null;
  }, []);
  useLayoutEffect(() => cancel, [cancel]);
  useLayoutEffect(() => {
    const intent = pending.current;
    if (!intent) return;
    if (!intent.current()) return cancel();
    if (!intent.ready()) return;
    const document = intent.source.ownerDocument;
    const target = intent.target();
    cancel();
    if (document.activeElement !== intent.source && document.activeElement !== document.body) return;
    if (target?.isConnected && !target.matches(':disabled')) target.focus();
  });
  return {
    cancel,
    begin(
      event: MouseEvent<HTMLButtonElement> | undefined,
      current: () => boolean,
      target: () => HTMLElement | null | undefined,
      ready = () => true,
    ) {
      cancel();
      if (!event || event.detail !== 0) return;
      const source = event.currentTarget;
      const document = source.ownerDocument;
      if (document.activeElement !== source || !current()) return;
      const moved = (event: FocusEvent) => {
        if (event.target !== source) cancel();
      };
      const left = () => {
        // Removal or disabling during this transition may itself drop focus.
        if (source.isConnected && !source.disabled) cancel();
      };
      const tabbed = (event: KeyboardEvent) => {
        if (event.key === 'Tab') cancel();
      };
      document.addEventListener('focusin', moved, true);
      source.addEventListener('focusout', left);
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('keydown', tabbed, true);
      document.defaultView?.addEventListener('blur', cancel);
      pending.current = {
        source,
        current,
        target,
        ready,
        dispose: () => {
          document.removeEventListener('focusin', moved, true);
          source.removeEventListener('focusout', left);
          document.removeEventListener('pointerdown', cancel, true);
          document.removeEventListener('keydown', tabbed, true);
          document.defaultView?.removeEventListener('blur', cancel);
        },
      };
    },
  };
}
