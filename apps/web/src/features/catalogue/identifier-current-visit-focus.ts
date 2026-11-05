/** Interaction or retirement cancels both a pending read's focus and an already queued frame. */
export function identifierReturnFocus(document: Document, current: () => boolean) {
  const view = document.defaultView!;
  let cancelled = false;
  let frame: number | undefined;
  const events = ['pointerdown', 'keydown', 'focusin', 'wheel'] as const;
  function cancel() {
    cancelled = true;
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    for (const event of events) document.removeEventListener(event, cancel, true);
  }
  for (const event of events) document.addEventListener(event, cancel, true);
  return {
    cancel,
    settle(target: HTMLElement) {
      if (cancelled) return;
      frame = view.requestAnimationFrame(() => {
        if (!cancelled && current() && target.isConnected) {
          cancel();
          target.focus();
        } else cancel();
      });
    },
  };
}
