import { managedReadTimeout } from '../settings/managed-read-deadline';

// Session preparation plus two parallel read phases, with room for the BFF round trip.
export const verificationPageTimeout = 3 * managedReadTimeout + 5_000;
export const verificationCommandTimeout = 2 * managedReadTimeout + 5_000;

/** Bound headers and decoding even when a transport ignores abort. Command cancellation is uncertain. */
export async function withVerificationDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
  timeout = managedReadTimeout,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Verification request timed out', 'TimeoutError')),
    timeout,
  );
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  try {
    return await Promise.race([interrupted, ...(controller.signal.aborted ? [] : [request(controller.signal)])]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
