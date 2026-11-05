/** One private read owns its deadline through headers, body and BFF transport.
 * Race cancellation as well as forwarding it: a stalled transport may ignore abort.
 * Callers map rejection to their existing unavailable state; this never retries.
 */
export async function privateAuthRead<T>(read: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  if (caller?.aborted) cancel();
  else caller?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Private read timed out', 'TimeoutError')), 5000);
  let onAbort: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    return await Promise.race([
      cancelled,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return read(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
