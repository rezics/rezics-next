/**
 * Delay every animation frame callback by 400 ms, as a host under heavy load does. Stories that act or check before
 * an update that waits for a frame has settled fail under it, so `test:stories:slow-frames` finds them on purpose.
 */
const delayMs = 400;
const pending = new Map<number, ReturnType<typeof setTimeout>>();
let nextHandle = 1;

window.requestAnimationFrame = (callback) => {
  const handle = nextHandle++;
  pending.set(
    handle,
    setTimeout(() => {
      pending.delete(handle);
      callback(performance.now());
    }, delayMs),
  );
  return handle;
};

window.cancelAnimationFrame = (handle) => {
  clearTimeout(pending.get(handle));
  pending.delete(handle);
};
