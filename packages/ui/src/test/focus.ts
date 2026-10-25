/**
 * Wait on the intended control before typing or sending keyboard navigation.
 * An overlay may also accept its associated input (comboboxes keep focus there).
 * The same active element must hold focus for two frames, rejecting transient autofocus.
 */
export function waitForFocus(target: HTMLElement | readonly HTMLElement[], timeoutMs = 1000,
  refocus?: () => void): Promise<void> {
  const targets: readonly HTMLElement[] = Array.isArray(target) ? target : [target as HTMLElement];
  const document = targets[0]?.ownerDocument;
  const window = document?.defaultView;
  if (!window) return Promise.reject(new Error('Focus target has no window'));

  return new Promise((resolve, reject) => {
    let frame: number;
    let focusedFrames = 0;
    let previous: Element | null = null;
    const timeout = window.setTimeout(() => {
      window.cancelAnimationFrame(frame);
      reject(new Error(`Focus did not settle inside the target; active element: ${document?.activeElement?.tagName}`));
    }, timeoutMs);
    const check = () => {
      const active = document!.activeElement;
      const intended = active && targets.some(element => element.isConnected && element.contains(active));
      focusedFrames = intended ? active === previous ? focusedFrames + 1 : 1 : 0;
      previous = active;
      // A modal's delayed focus move can undo the user's field selection. Restore
      // that explicit choice, then require two later frames to agree before typing.
      if (!intended) refocus?.();
      if (focusedFrames === 2) {
        window.clearTimeout(timeout);
        resolve();
      } else {
        frame = window.requestAnimationFrame(check);
      }
    };
    frame = window.requestAnimationFrame(check);
  });
}

/** Select a typing control and keep that choice through an overlay's scheduled focus move. */
export function focusForTyping(target: HTMLElement, timeoutMs = 1000): Promise<void> {
  target.focus();
  return waitForFocus(target, timeoutMs, () => target.focus());
}
