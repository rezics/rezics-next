/** Match Web account reads: one ten-second budget includes headers and the complete body. */
export const managedReadTimeout = 10_000;

/** Read-only recovery: cancellation never establishes whether a command took effect. */
export async function withManagedReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  let rejectAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Account read timed out', 'TimeoutError')),
    managedReadTimeout,
  );
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  try {
    // Race even non-cooperative transports and stalled response-body consumers.
    return await Promise.race([interrupted, ...(controller.signal.aborted ? [] : [read(controller.signal)])]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
