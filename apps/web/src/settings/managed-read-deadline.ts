import type { SettingsTimer } from './ports/ambient';

/** Match Web account reads: one ten-second budget includes headers and the complete body. */
export const managedReadTimeout = 10_000;

/** Read-only recovery: cancellation never establishes whether a command took effect. */
export async function withManagedReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  caller: AbortSignal | undefined,
  timer: SettingsTimer,
): Promise<T> {
  return withScheduledDeadline(read, caller, timer, managedReadTimeout, 'Account read timed out');
}

export async function withScheduledDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  caller: AbortSignal | undefined,
  timer: SettingsTimer,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  let rejectAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const scheduled = timer.schedule(() => controller.abort(new DOMException(message, 'TimeoutError')), timeoutMs);
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  try {
    // Race even non-cooperative transports and stalled response-body consumers.
    return await Promise.race([interrupted, ...(controller.signal.aborted ? [] : [request(controller.signal)])]);
  } finally {
    scheduled.cancel();
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
