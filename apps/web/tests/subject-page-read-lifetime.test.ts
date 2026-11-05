import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/subject-page.json';
import realmRecording from '../src/kernel/recorded/realm.json';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
};
type ServerCall = { signal: AbortSignal; settled: Promise<void> };
type NativeCall = { signal?: AbortSignal; result: Deferred<{ status: number; data?: unknown }> };
const serverCalls: ServerCall[] = [];
const nativeCalls: NativeCall[] = [];
const serverWaiters: Deferred<ServerCall>[] = [];
const nativeWaiters: Deferred<NativeCall>[] = [];
let currentRequest = new Request('https://site.test/_server');
let activeClient: unknown;
let preparation: Deferred<void> | undefined;
let preparationEntered: Deferred<void> | undefined;

const nextServerCall = () => {
  const next = deferred<ServerCall>();
  serverWaiters.push(next);
  return next.promise;
};
const nextNativeCall = () => {
  const next = deferred<NativeCall>();
  nativeWaiters.push(next);
  return next.promise;
};

function createServerFn() {
  let validate = (value: unknown) => value;
  const chain = {
    validator(next: (value: unknown) => unknown) {
      validate = next;
      return chain;
    },
    handler(handler: (input: { data: unknown }) => unknown) {
      return (options: { data?: unknown; signal?: AbortSignal }) => {
        currentRequest = new Request('https://site.test/_server', { signal: options.signal });
        const work = Promise.resolve(handler({ data: validate(options.data) }));
        const call = {
          signal: currentRequest.signal,
          settled: work.then(
            () => {},
            () => {},
          ),
        };
        serverCalls.push(call);
        serverWaiters.shift()?.resolve(call);
        return work;
      };
    },
  };
  return chain;
}

mock.module('@tanstack/react-start', () => ({ ...start, createServerFn }));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => {
    if (preparation) {
      preparationEntered?.resolve();
      await preparation.promise;
    }
    return null;
  },
  viewerCredential: () => null,
  sessionSubject: () => null,
  requestCsrfToken: () => null,
}));
mock.module('../src/kernel/client', () => ({
  kernelClient: () => activeClient as never,
  requestLocale: () => undefined,
  configuredKernelOrigin: () => undefined,
  hasKernelOrigin: () => false,
  preparePrivatePage: () => {},
  acceptLanguage: () => '',
}));

const { subjectPageQuery, subjectViewPagesQuery } = await import('../src/features/pages/subject-queries');
const { readPageAuthors } = await import('../src/identity/read');
const { readTermsPageAuthority } = await import('../src/features/catalogue/subject-terms-request');
const subjectId = recording.subject;
const viewDocument = {
  root: { props: {} },
  content: [
    { type: 'SubjectList', props: { id: 'editions', property: 'schema:exampleOfWork', limit: 12, paged: true } },
  ],
};
const pageData = (document = { root: { props: {} }, content: [] }) => ({
  ...recording,
  document,
  reads: {},
  catalogue: undefined,
});

function installClient() {
  serverCalls.length = 0;
  nativeCalls.length = 0;
  serverWaiters.length = 0;
  nativeWaiters.length = 0;
  activeClient = {
    pages: {
      $read: {
        post: (_body: unknown, options: { fetch?: { signal?: AbortSignal } }) => {
          const call: NativeCall = { signal: options.fetch?.signal, result: deferred() };
          nativeCalls.push(call);
          nativeWaiters.shift()?.resolve(call);
          return call.result.promise;
        },
      },
    },
  };
}

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

test('retirement during Realm session preparation prevents the native page read', async () => {
  installClient();
  preparation = deferred<void>();
  preparationEntered = deferred<void>();
  const started = preparationEntered.promise;
  const server = nextServerCall();
  const query = subjectPageQuery(subjectId, 'en', 'overview', realmRecording.realm.realmId, null);
  const client = queryClient();
  const observer = new QueryObserver(client, query);
  const unsubscribe = observer.subscribe(() => {});
  const call = await server;
  await started;
  unsubscribe();
  expect(call.signal.aborted).toBe(true);
  preparation.resolve();
  await call.settled;
  expect(nativeCalls).toHaveLength(0);
  client.clear();
  preparation = undefined;
  preparationEntered = undefined;
});

test('an ignored named-view continuation abort cannot schedule its overview read', async () => {
  installClient();
  const query = subjectViewPagesQuery(subjectId, 'en', 'editions', 'opaque:cursor');
  const observer = new QueryObserver(queryClient(), query);
  const initialRead = nextNativeCall();
  const unsubscribe = observer.subscribe(() => {});
  const first = await initialRead;
  first.result.resolve({ status: 200, data: pageData(viewDocument) });
  const continuationRead = nextNativeCall();
  const continuation = await continuationRead;
  expect(continuation.signal).toBe(first.signal);
  unsubscribe();
  expect(continuation.signal?.aborted).toBe(true);
  continuation.result.resolve({ status: 200, data: pageData(viewDocument) });
  const server = serverCalls.find((call) => call.signal === continuation.signal);
  expect(server).toBeDefined();
  await server!.settled;
  expect(nativeCalls).toHaveLength(2);
});

test('an exact remaining observer retains shared work and a fresh return gets a current page', async () => {
  installClient();
  const client = queryClient();
  const query = subjectPageQuery(subjectId, 'en');
  const firstRead = nextNativeCall();
  const firstObserver = new QueryObserver(client, query);
  const leaveFirst = firstObserver.subscribe(() => {});
  const abandoned = await firstRead;
  const secondObserver = new QueryObserver(client, query);
  const leaveSecond = secondObserver.subscribe(() => {});
  leaveFirst();
  expect(abandoned.signal?.aborted).toBe(false);
  leaveSecond();
  expect(abandoned.signal?.aborted).toBe(true);

  const freshRead = nextNativeCall();
  const freshObserver = new QueryObserver(client, query);
  const succeeded = deferred<void>();
  const leaveFresh = freshObserver.subscribe((result) => {
    if (result.status === 'success') succeeded.resolve();
  });
  const current = await freshRead;
  expect(current.signal).not.toBe(abandoned.signal);
  abandoned.result.resolve({ status: 308, data: { redirect: { to: 'stale-survivor' } } });
  const oldServer = serverCalls.find((call) => call.signal === abandoned.signal);
  expect(oldServer).toBeDefined();
  await oldServer!.settled;
  expect(freshObserver.getCurrentResult().status).toBe('pending');
  expect(client.getQueryData(query.queryKey)).toBeUndefined();
  current.result.resolve({ status: 200, data: pageData() });
  await succeeded.promise;
  expect(freshObserver.getCurrentResult().data).toMatchObject({ kind: 'page', page: { subject: subjectId } });
  leaveFresh();
});

test('ignored aborts cannot settle optional advice or author hydration', async () => {
  const authorController = new AbortController();
  const authorWork = deferred<{ data: { accounts: { id: string }[] } }>();
  let authorSignal: AbortSignal | undefined;
  const authorRead = readPageAuthors(
    {
      accounts: {
        get: (options: { fetch: { signal: AbortSignal } }) => {
          authorSignal = options.fetch.signal;
          return authorWork.promise;
        },
      },
    } as never,
    ['author-id'],
    authorController.signal,
  );
  authorController.abort();
  authorWork.resolve({ data: { accounts: [{ id: 'author-id' }] } });
  await expect(authorRead).rejects.toThrow();
  expect(authorSignal?.aborted).toBe(true);

  const adviceController = new AbortController();
  const adviceWork = deferred<{ status: number; data: { resources: unknown[] } }>();
  let adviceSignal: AbortSignal | undefined;
  const adviceRead = readTermsPageAuthority(
    {
      viewerActions: {
        post: (_body: unknown, options: { fetch: { signal: AbortSignal } }) => {
          adviceSignal = options.fetch.signal;
          return adviceWork.promise;
        },
      },
    } as never,
    'signed-in',
    'Bearer current-reader',
    adviceController.signal,
  );
  adviceController.abort();
  adviceWork.resolve({ status: 200, data: { resources: [] } });
  await expect(adviceRead).rejects.toThrow();
  expect(adviceSignal?.aborted).toBe(true);
});
