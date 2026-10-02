/**
 * Overlay presence is earlier than its scheduled focus move. Wait for focus
 * inside the overlay before choosing a field, or on a control before typing
 * or sending keyboard navigation. Two frames reject transient autofocus.
 */
export function waitForFocus(target: HTMLElement): Promise<void> {
  const window = target.ownerDocument.defaultView;
  if (!window) return Promise.reject(new Error('Focus target has no window'));

  return new Promise((resolve, reject) => {
    let frame: number;
    let focusedFrames = 0;
    const timeout = window.setTimeout(() => {
      window.cancelAnimationFrame(frame);
      reject(new Error('Focus did not settle inside the target'));
    }, 1000);
    const check = () => {
      focusedFrames = target.contains(target.ownerDocument.activeElement) ? focusedFrames + 1 : 0;
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
