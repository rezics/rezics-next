import { treaty, type Treaty } from '@elysia/eden';
import type { DefaultMetadata, DefaultSingleton, Elysia } from 'elysia';
import type { SESSION_HEADER as KernelSessionHeader } from './kernel/http/request.ts';
import type { ClientKernel as KernelType } from './kernel/http/kernel.ts';
import type { subjectRoutes } from './kernel/semantic/http/subjects.ts';

export type { ClientKernel as Kernel } from './kernel/http/kernel.ts';

type Routes = KernelType['~Routes']['v1'];

/** Reuse each shared method's original declaration; retain every other mounted path and method. */
type SharedRoutes<Mounted, Original> = Original extends { body: unknown; response: unknown }
  ? Original
  : {
      [Path in keyof Mounted]: Path extends keyof Original
        ? SharedRoutes<Mounted[Path], Original[Path]>
        : Mounted[Path];
    };

// Many modules inherit subjectRoutes. Intersecting their repeated anonymous 422 unions grows exponentially.
type SubjectRoutes = SharedRoutes<Routes['subjects'], ReturnType<typeof subjectRoutes>['~Routes']['v1']['subjects']>;

// Eden derives the wire client from `~Routes`; the remaining Elysia generics
// describe server composition and are not part of the client's type surface.
type ClientApp = Elysia<
  KernelType['~Prefix'],
  'local',
  DefaultSingleton,
  { typebox: {}; error: [] },
  DefaultMetadata,
  {
    [Prefix in keyof KernelType['~Routes']]: Prefix extends 'v1'
      ? Omit<Routes, 'subjects'> & { subjects: SubjectRoutes }
      : KernelType['~Routes'][Prefix];
  }
>;

/** Each group is derived from the complete mounted kernel, including routes contributed by other modules. */
export type KernelClient = Omit<ReturnType<typeof treaty<ClientApp>>['v1'], 'subjects'> & {
  subjects: KernelSubjectsClient;
};
export type KernelSubjectsClient = Treaty.Sign<{ subjects: SubjectRoutes }>['subjects'];
export type SubjectRead = SubjectRoutes[':id']['get']['response'][200];

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
export function createKernelClient(origin: string, options: KernelClientOptions = {}): KernelClient {
  let session = options.session;
  const fetcher = options.fetch ?? globalThis.fetch;
  const config = {
    fetcher: ((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(/\/\$([a-z][A-Za-z0-9]*)$/, ':$1');
      if (path === url.pathname) return fetcher(input, init);
      url.pathname = path;
      return fetcher(input instanceof Request ? new Request(url, input) : url.href, init);
    }) as typeof fetch,
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
  return treaty<ClientApp>(origin, config).v1;
}
