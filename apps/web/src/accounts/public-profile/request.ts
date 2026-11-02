import type { KernelClient } from '@rezics/client';
import { readWithin } from '../management/read-deadline';

// Match account management: primary reads get ten seconds, optional labels two.
const PUBLIC_READ_MS = 10_000;
export const OPERATOR_READ_MS = 2_000;

type ReadOptions = { fetch?: RequestInit };

/** Bind only this journey's reads, leaving the shared client and its session handling intact. */
function withSignal(client: KernelClient, signal: AbortSignal): KernelClient {
  function scope<T extends object>(target: T, path: string[] = []): T {
    return new Proxy(target, {
      get(target, key) {
        const value = Reflect.get(target, key);
        // pages:read is a read transported as POST, never a command to replay.
        const optionsAt = key === 'get' ? 0 : key === 'post' && path.join('.') === 'pages.$read' ? 1 : -1;
        if (optionsAt >= 0 && typeof value === 'function')
          return (...args: unknown[]) => {
            signal.throwIfAborted();
            const options = args[optionsAt] as ReadOptions | undefined;
            args[optionsAt] = { ...options, fetch: { ...options?.fetch, signal } };
            return Reflect.apply(value, target, args);
          };
        return value !== null && (typeof value === 'function' || typeof value === 'object')
          ? scope(value, [...path, String(key)])
          : value;
      },
      apply(target, receiver, args) {
        return scope(Reflect.apply(target as (...args: unknown[]) => object, receiver, args), path);
      },
    });
  }
  return scope(client);
}

/** The phase's deadline includes headers, decoding and bounded parallel hydration. */
export function publicAccountRead<T>(
  client: KernelClient,
  read: (client: KernelClient) => Promise<T>,
  caller?: AbortSignal,
  milliseconds = PUBLIC_READ_MS,
): Promise<T> {
  let close = () => {};
  return readWithin(
    (signal) => {
      const transport = new AbortController();
      const cancel = () => transport.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      close = () => {
        signal.removeEventListener('abort', cancel);
        // Retire sibling reads if one parallel producer fails before the deadline.
        transport.abort();
      };
      return read(withSignal(client, transport.signal));
    },
    caller,
    milliseconds,
  ).finally(() => close());
}
