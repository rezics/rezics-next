import { useLayoutEffect, useRef, type MouseEvent } from 'react';

type Intent = {
  source: HTMLButtonElement;
  action: string | null;
  current: () => boolean;
  settled: boolean;
  cancel: () => void;
};

/** One explicit command in one mounted contribution holder; no read can complete this intent. */
export function useContributionResultFocus() {
  const boundaryRef = useRef<HTMLParagraphElement>(null);
  const pending = useRef<Intent | null>(null);
  const suppressCloseFocus = useRef(false);
  const cancel = () => pending.current?.cancel();

  useLayoutEffect(() => cancel, []);
  useLayoutEffect(() => {
    const intent = pending.current;
    if (!intent) return;
    if (!intent.current()) return intent.cancel();
    if (!intent.settled) return;
    const { source } = intent;
    const document = source.ownerDocument;
    const active = document.activeElement;
    intent.cancel();
    if (active !== source && active !== document.body && active !== document.documentElement) return;
    // A retry that still means the same command remains the reader's useful control.
    const survives =
      intent.action !== null &&
      source.isConnected &&
      !source.disabled &&
      source.getAttribute('data-contribution-action') === intent.action;
    const target = survives ? source : boundaryRef.current;
    if (target?.isConnected && active !== target) target.focus();
  });

  return {
    boundaryRef,
    suppressCloseFocus,
    cancel,
    start(event: MouseEvent<HTMLButtonElement>, current: () => boolean) {
      cancel();
      const source = event.currentTarget;
      const document = source.ownerDocument;
      if (event.detail !== 0 || document.activeElement !== source || !current()) return null;
      const intent: Intent = {
        source,
        action: source.getAttribute('data-contribution-action'),
        current,
        settled: false,
        cancel() {
          document.removeEventListener('focusin', moved, true);
          document.removeEventListener('focusout', blurred, true);
          if (pending.current === intent) pending.current = null;
        },
      };
      const moved = (event: FocusEvent) => {
        if (event.target === source) return;
        if (
          (event.target === document.body || event.target === document.documentElement) &&
          (!source.isConnected || source.disabled)
        )
          return;
        intent.cancel();
      };
      const blurred = (event: FocusEvent) => {
        if (event.target !== source) return;
        // Removal/disable is expected; deliberate blur of a useful control retires the intent.
        queueMicrotask(() => {
          if (source.isConnected && !source.disabled && !source.closest('[data-closed]')) intent.cancel();
        });
      };
      pending.current = intent;
      document.addEventListener('focusin', moved, true);
      document.addEventListener('focusout', blurred, true);
      return intent;
    },
    complete(intent: Intent | null) {
      if (intent && pending.current === intent) intent.settled = true;
    },
  };
}
