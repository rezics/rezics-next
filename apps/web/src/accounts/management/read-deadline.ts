/** Keep the deadline through body decoding, even when a transport ignores cancellation. */
export async function readWithin<T>(
  read: (signal: AbortSignal) => Promise<T>,
  caller: AbortSignal | undefined,
  milliseconds: number,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Account read timed out', 'TimeoutError')),
    milliseconds,
  );
  let onAbort: () => void = () => {};
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    caller?.addEventListener('abort', cancel, { once: true });
    if (caller?.aborted) cancel();
    const result = (async () => {
      controller.signal.throwIfAborted();
      return read(controller.signal);
    })();
    return await Promise.race([interrupted, result]);
  } finally {
    clearTimeout(timeout);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
