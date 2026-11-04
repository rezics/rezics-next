type Intent = {
  request: string;
  cursor: string | null;
  action: string;
  source: HTMLElement;
  moved: boolean;
  stop: () => void;
};

/** One activated page action owns focus until settlement, replacement, cancellation or a focus move. */
export function searchWindowFocus() {
  let intent: Intent | undefined;
  const retire = () => {
    intent?.stop();
    intent = undefined;
  };
  return {
    retire,
    capture(request: string, cursor: string | null, action: string, source: HTMLElement) {
      retire();
      const document = source.ownerDocument;
      if (document.activeElement !== source) return;
      const pending: Intent = {
        request, cursor, action, source, moved: false,
        stop: () => document.removeEventListener('focusin', moved, true),
      };
      function moved(event: FocusEvent) {
        if (event.target !== source && event.target !== document.body && event.target !== document.documentElement)
          pending.moved = true;
      }
      document.addEventListener('focusin', moved, true);
      intent = pending;
    },
    settle(request: string, cursor: string | null, navigation: HTMLElement | null, region: HTMLElement | null) {
      const pending = intent;
      if (!pending) return;
      if (pending.request !== request) { retire(); return; }
      if (pending.cursor !== cursor) return;
      const document = pending.source.ownerDocument;
      const active = document.activeElement;
      const owns = !pending.moved && (active === pending.source || active === document.body || active === document.documentElement);
      const action = navigation?.querySelector<HTMLElement>(`[data-window-action="${pending.action}"]:not([aria-disabled="true"])`);
      const recovery = region?.querySelector<HTMLElement>('[data-search-recovery] button:not(:disabled), [data-search-recovery] a[href]:not([aria-disabled="true"])');
      retire();
      if (owns) (action ?? recovery ?? region)?.focus();
    },
  };
}
