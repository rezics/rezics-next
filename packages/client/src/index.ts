import { treaty } from '@elysia/eden';
import type { SESSION_HEADER as KernelSessionHeader } from './kernel/http/request.ts';
import type { Kernel as KernelType } from './kernel/http/kernel.ts';

export type { Kernel } from './kernel/http/kernel.ts';

export const SESSION_HEADER: typeof KernelSessionHeader = 'rezics-session-token';

export type KernelClientOptions = {
  /** Fetch implementation used for requests. */
  fetch?: typeof fetch;
  /** Additional headers sent with each request. */
  headers?: Record<string, string>;
  /** Session token to send with the first request. */
  session?: string;
  /** Called when the kernel returns a different session token. */
  onSession?: (token: string) => void;
};

/** Creates one viewer's client and keeps its session token so the viewer's reads see its own writes. */
export function createKernelClient(origin: string, options: KernelClientOptions = {}) {
  let session = options.session;
  const config = {
    ...(options.fetch === undefined ? {} : { fetcher: options.fetch }),
    parseDate: false,
    headers: () => ({
      ...options.headers,
      ...(session === undefined ? {} : { [SESSION_HEADER]: session }),
    }),
    onResponse(response: Response) {
      const token = response.headers.get(SESSION_HEADER);
      if (token !== null && token !== session) {
        session = token;
        options.onSession?.(token);
      }
    },
  };
  return treaty<KernelType>(origin, config).v1;
}

export type KernelClient = ReturnType<typeof createKernelClient>;
