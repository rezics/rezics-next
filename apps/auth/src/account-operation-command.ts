import {
  ACCOUNT_OPERATION_MAX_ERROR_BYTES,
  parseAccountOperationRefusal,
  type AccountOperationRefusal,
} from '@rezics/auth-contract';
import { AUTH_POST_TIMEOUT_MS } from './api';
import { readJsonBounded } from './private-auth-json';

type Reply<T> = { kind: 'received'; value: T } | { kind: 'refused'; status: number; value: AccountOperationRefusal };
type Unavailable = { kind: 'unavailable' };

/** Each deliberate POST owns one existing lifetime through headers AND body.
 * The send boundary runs synchronously immediately before fetch. Cancellation
 * releases the caller even when fetch or a body stream ignores abort.
 */
export async function sendAccountOperation<T>(
  phase: 'approve' | 'execute',
  body: unknown,
  maxBytes: number,
  parse: (value: unknown) => T | null,
  dispatch: () => boolean,
  caller?: AbortSignal,
): Promise<Reply<T> | Unavailable> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  const timer = setTimeout(cancel, AUTH_POST_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  try {
    const cancelled = new Promise<Unavailable>((resolve) => {
      onAbort = () => resolve({ kind: 'unavailable' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const post = async (): Promise<Reply<T> | Unavailable> => {
      const serialized = JSON.stringify(body);
      controller.signal.throwIfAborted();
      if (!dispatch()) return { kind: 'unavailable' };
      const response = await fetch(`/account-operations/${phase}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: serialized,
        signal: controller.signal,
      });
      const value = await readJsonBounded(
        response,
        response.status === 200 ? maxBytes : ACCOUNT_OPERATION_MAX_ERROR_BYTES,
        controller.signal,
      );
      if (response.status === 200) {
        const admitted = parse(value);
        return admitted ? { kind: 'received', value: admitted } : { kind: 'unavailable' };
      }
      const refusal = parseAccountOperationRefusal(value, response.status);
      return refusal ? { kind: 'refused', status: response.status, value: refusal } : { kind: 'unavailable' };
    };
    return await Promise.race([cancelled, post()]);
  } catch {
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
