import { managedReadTimeout } from './managed-read-deadline';

/** A deadline bounds observation; aborting a PATCH does not establish its outcome. */
export async function withProfileDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason);
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Profile request timed out', 'TimeoutError')),
    managedReadTimeout,
  );
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  try {
    // Include response decoding and settle even a non-cooperative transport.
    return await Promise.race([interrupted, ...(controller.signal.aborted ? [] : [request(controller.signal)])]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
