import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { SubjectRead } from '@rezics/client';

const anchor = '00000000-0000-4000-8000-00000000d101';
const target = '00000000-0000-4000-8000-00000000d103';
const contextA = '00000000-0000-4000-8000-000000000021';
const contextB = '00000000-0000-4000-8000-000000000022';
const realm = '00000000-0000-4000-8000-000000000023';
const callerA = '00000000-0000-4000-8000-00000000d201';
const callerB = '00000000-0000-4000-8000-00000000d202';
const sessionObservations = new Map([
  [callerA, { state: 'signed-in' as const, subject: callerA, csrfToken: 'caller-a-token' }],
  [callerB, { state: 'signed-in' as const, subject: callerB, csrfToken: 'caller-b-token' }],
]);
let sessionObservation = sessionObservations.get(callerA)!;
let release: unknown;
let nativeClient: unknown;
const readerCalls: string[] = [];

function serverFunction() {
  let validate: ((data: unknown) => unknown) | undefined;
  const chain = {
    validator(next: typeof validate) {
      validate = next;
      return chain;
    },
    handler(handler: (input: { data: unknown }) => unknown) {
      return async (input: { data?: unknown } = {}) => handler({ data: validate ? validate(input.data) : input.data });
    },
  };
  return chain;
}

mock.module('@tanstack/react-start', () => ({ ...start, createServerFn: serverFunction }));
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const originalSessionQuery = await import('../src/session/query');
mock.module('../src/session/query', () => ({
  ...originalSessionQuery,
  useSession: () => sessionObservation,
}));
mock.module('../src/features/pages/graph-browser/actions', () => ({
  exploreContext: async (_locale: string, expectedReader?: string | null) => {
    readerCalls.push(expectedReader ?? '');
    return { client: nativeClient, authorization: undefined };
  },
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({}) }));
mock.module('../src/shell/feature-slots', () => ({ useFeatureSlots: () => ({}) }));

const { musicLocationExample } = await import('../src/features/catalogue/music-location-reader/examples');
const fixture = musicLocationExample('admitted-place');
fixture.release.types['schema:Place']!.properties.push('schema:location');
release = fixture.release;

type DeferredSubject = {
  id: string;
  query: Record<string, unknown>;
  fetch: Record<string, unknown>;
  resolve: (value: unknown) => void;
};
type NativeCall = { id: string; query: Record<string, unknown>; fetch: Record<string, unknown> };
const subjectCalls: DeferredSubject[] = [];
const relationCalls: NativeCall[] = [];
let relationTargetType = 'schema:AdministrativeArea';
let relationFailureOnce = false;

function deferredSubject() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeSubject(
  context: string,
  label: string,
  actualContext = context,
  sourceRelease = fixture.public.subject.release,
): SubjectRead {
  const value = structuredClone(fixture.public);
  value.subject.id = anchor;
  value.subject.context = actualContext;
  value.subject.release = sourceRelease;
  value.subject.labels = { en: label };
  return value;
}

nativeClient = {
  contexts: ({ id }: { id: string }) => ({
    get: async () => ({ status: 200, data: { context: { id } }, headers: new Headers() }),
  }),
  definitions: {
    active: {
      get: async () => ({
        status: 200,
        data: { digest: fixture.public.subject.release },
        headers: new Headers(),
      }),
    },
    releases: ({ digest }: { digest: string }) => ({
      get: async () => ({ status: 200, data: { digest, release }, headers: new Headers() }),
    }),
  },
  subjects: ({ id }: { id: string }) => ({
    get: (options: { query: Record<string, unknown>; fetch: Record<string, unknown> }) => {
      const pending = deferredSubject();
      subjectCalls.push({ id, query: options.query, fetch: options.fetch, resolve: pending.resolve });
      return pending.promise;
    },
    relations: {
      get: async (options: { query: Record<string, unknown>; fetch: Record<string, unknown> }) => {
        relationCalls.push({ id, query: options.query, fetch: options.fetch });
        if (relationFailureOnce) {
          relationFailureOnce = false;
          return { status: 503, data: undefined, headers: new Headers() };
        }
        const property = options.query.property;
        const context = String(options.query.context);
        return {
          status: 200,
          data: {
            relations: [
              {
                statement: { id: '00000000-0000-4000-8000-00000000d111', property: { id: property }, qualifiers: [] },
                summary: {
                  id: target,
                  type: relationTargetType,
                  label: { value: `Area in ${context}`, language: 'en' },
                },
              },
            ],
            next: options.query.cursor ? null : 'music-cursor-1',
          },
          headers: new Headers(),
        };
      },
    },
  }),
};

const [
  { Window },
  { MusicContextSession },
  { SubjectExploreSlot },
  { renderToStaticMarkup },
  { musicContextRouteSearch },
  { candidateContext },
  { sessionQuery },
  { browserObservation },
] = await Promise.all([
  import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))),
  import('../src/features/catalogue/music-context-profile/session'),
  import('../src/features/pages/subject-slots'),
  import('react-dom/server'),
  import('../src/features/catalogue/music-context-profile/navigation'),
  import('../src/subject/candidates'),
  import('../src/session/query'),
  import('../src/session'),
]);

const window = new Window({ url: `https://site.test/en/subjects/${anchor}/harbor-stage/music-context`, width: 390 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLSelectElement: window.HTMLSelectElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(predicate: () => boolean, detail?: () => string) {
  for (let turn = 0; turn < 80; turn++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`Music-context selected reading did not settle${detail ? `: ${detail()}` : ''}`);
}

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('selected Context stays bound through the Subject entry, route, session, action and native reading', async () => {
  subjectCalls.length = 0;
  relationCalls.length = 0;
  readerCalls.length = 0;
  const { readSubjectMusicContext } = await import('../src/features/catalogue/music-context-profile/actions');
  const compatibleReturn = `/en/subjects/${anchor}/harbor-stage/quotations?context=${contextA}`;
  const entryMarkup = renderToStaticMarkup(
    createElement(SubjectExploreSlot, {
      subjectId: anchor,
      subjectType: 'schema:Place',
      label: 'Harbor Stage',
      locale: 'en',
      context: contextA,
      returnTo: compatibleReturn,
    }),
  );
  const entryHref = [...entryMarkup.matchAll(/href="([^"]+)"/gu)]
    .map((match) => match[1]!.replaceAll('&amp;', '&'))
    .find((href) => href.includes('/music-context'));
  if (!entryHref) throw new Error('The admitted Subject slot did not render its music-context entry');
  const entryUrl = new URL(entryHref, 'https://site.test');
  const route = musicContextRouteSearch(Object.fromEntries(entryUrl.searchParams), 'en', {
    subjectId: anchor,
    pathname: entryUrl.pathname,
  });
  expect(route?.context).toBe(contextA);
  expect(route?.returnTo).toBe(compatibleReturn);
  const incompatibleEntryMarkup = renderToStaticMarkup(
    createElement(SubjectExploreSlot, {
      subjectId: anchor,
      subjectType: 'schema:Place',
      label: 'Harbor Stage',
      locale: 'en',
      context: contextA,
      returnTo: `/en/subjects/${anchor}/harbor-stage?context=${contextA}`,
    }),
  );
  const incompatibleEntryHref = [...incompatibleEntryMarkup.matchAll(/href="([^"]+)"/gu)]
    .map((match) => match[1]!.replaceAll('&amp;', '&'))
    .find((href) => href.includes('/music-context'));
  if (!incompatibleEntryHref) throw new Error('The unsupported-return Subject entry was not rendered');
  expect(new URL(incompatibleEntryHref, 'https://site.test').searchParams.get('context')).toBe(contextA);
  expect(new URL(incompatibleEntryHref, 'https://site.test').searchParams.has('returnTo')).toBe(false);
  expect(musicContextRouteSearch({ context: 'not-a-context' }, 'en')).toBeUndefined();
  expect(musicContextRouteSearch({}, 'en')).toEqual({});
  expect(musicContextRouteSearch({ context: candidateContext }, 'en')?.context).toBe(candidateContext);
  expect(
    musicContextRouteSearch({ context: contextA, returnTo: compatibleReturn }, 'en', { subjectId: anchor })?.returnTo,
  ).toBe(compatibleReturn);
  expect(
    musicContextRouteSearch(
      { context: contextA, returnTo: `/en/subjects/${anchor}/harbor-stage?context=${contextA}` },
      'en',
      { subjectId: anchor },
    ),
  ).toBeUndefined();
  const nestedOrigin = `/en/subjects/${target}/harbor-hall/music-context?context=${contextA}&via=${encodeURIComponent(
    `/en/subjects/${anchor}/harbor-stage/music-context?context=${contextA}`,
  )}`;
  expect(
    musicContextRouteSearch({ context: contextA, via: nestedOrigin }, 'en', { subjectId: anchor }),
  ).toBeUndefined();

  const oversizedReturn = `/en/subjects/${anchor}/${'界'.repeat(11_000)}`;
  expect(oversizedReturn.length).toBeLessThan(32_768);
  expect(new TextEncoder().encode(oversizedReturn).byteLength).toBeGreaterThan(32_768);
  expect(musicContextRouteSearch({ returnTo: oversizedReturn }, 'en', { subjectId: anchor })).toBeUndefined();
  const encodedCursor = encodeURIComponent(':'.repeat(8_192));
  const encodedOrigin = `/en/subjects/${anchor}/harbor-stage/relations?context=${candidateContext}&node=activity&cursor=${encodedCursor}`;
  expect(new TextEncoder().encode(encodedOrigin).byteLength).toBeLessThan(32_768);
  expect(
    musicContextRouteSearch({ context: candidateContext, returnTo: encodedOrigin }, 'en', { subjectId: anchor }),
  ).toBeUndefined();
  await expect(
    readSubjectMusicContext({ data: { id: anchor, locale: 'en', context: 'not-a-context', expectedReader: null } }),
  ).rejects.toThrow('Invalid music context address');
  expect(subjectCalls).toHaveLength(0);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setCaller = (subject: string) => {
    sessionObservation = sessionObservations.get(subject)!;
    queryClient.setQueryData(sessionQuery.queryKey, sessionObservation);
  };
  setCaller(callerA);
  const stopObservation = browserObservation(queryClient).subscribe(() => {});
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let routeStream: string | undefined;
  let routeCursor: string | undefined;
  const addressChanges: Array<{ context?: string; stream: string; cursor?: string }> = [];
  const render = async (context?: string, selectedRealm?: string) => {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(MusicContextSession, {
            id: anchor,
            locale: 'en',
            ...(context !== undefined ? { context } : {}),
            ...(selectedRealm !== undefined ? { realm: selectedRealm } : {}),
            ...(routeStream !== undefined ? { stream: routeStream } : {}),
            ...(routeCursor !== undefined ? { cursor: routeCursor } : {}),
            onAddressChange: (address: { context?: string; stream: string; cursor?: string }) => {
              addressChanges.push(address);
              routeStream = address.stream;
              routeCursor = address.cursor;
            },
          }),
        ),
      ),
    );
    await flush();
  };
  const resolve = async (
    index: number,
    context: string,
    label: string,
    actualContext = context,
    sourceRelease = fixture.public.subject.release,
  ) => {
    await act(async () => {
      subjectCalls[index]!.resolve({
        status: 200,
        data: nativeSubject(context, label, actualContext, sourceRelease),
        headers: new Headers(),
      });
      await Promise.resolve();
    });
  };

  try {
    await render(route?.context);
    await until(
      () => subjectCalls.length === 1,
      () =>
        `session=${JSON.stringify(sessionObservation)}; action readers=${readerCalls.length}; view=${host.textContent}`,
    );
    await render(contextB);
    await until(() => subjectCalls.length === 2);
    await render(contextA);
    await until(() => subjectCalls.length === 3);
    expect(subjectCalls.map((call) => call.query.context)).toEqual([contextA, contextB, contextA]);

    setCaller(callerB);
    await render(contextA);
    await until(() => subjectCalls.length === 4);
    setCaller(callerA);
    await render(contextA);
    await until(() => subjectCalls.length === 5);
    expect(readerCalls).toEqual([callerA, callerA, callerA, callerB, callerA]);

    await resolve(0, contextA, 'Retired Context A');
    await resolve(1, contextB, 'Retired Context B');
    await resolve(2, contextA, 'Retired Caller A');
    await resolve(3, contextA, 'Retired Caller B');
    await resolve(4, contextA, 'Current Context A');
    await until(() => relationCalls.length === 5 && host.textContent?.includes('Current Context A') === true);
    expect(host.textContent).toContain('Current Context A');
    expect(host.textContent).not.toContain('Retired Context A');
    expect(host.textContent).not.toContain('Retired Context B');
    expect(host.querySelector('[data-context]')?.getAttribute('data-context')).toBe(contextA);
    expect(relationCalls.map((call) => call.query.context)).toEqual([contextA, contextB, contextA, contextA, contextA]);
    expect(subjectCalls[4]?.fetch).toEqual({ cache: 'no-store', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(relationCalls[4]?.fetch).toEqual({ cache: 'no-store', redirect: 'manual', signal: expect.any(AbortSignal) });

    const next = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Next page'),
    );
    if (!next) throw new Error('The admitted Context did not expose its native continuation');
    await act(async () => {
      next.click();
      await Promise.resolve();
    });
    await until(() => subjectCalls.length === 6);
    await resolve(5, contextA, 'Continued Context A');
    await until(() => relationCalls.length === 6 && host.textContent?.includes('Continued Context A') === true);
    await render(contextA);
    expect(relationCalls[5]?.query).toMatchObject({ context: contextA, cursor: 'music-cursor-1' });
    expect(addressChanges.at(-1)).toEqual({
      context: contextA,
      stream: relationCalls[5]?.query.property,
      cursor: 'music-cursor-1',
    });

    const previous = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Previous page'),
    );
    if (!previous) throw new Error('The admitted Context did not retain its bounded Previous address');
    await act(async () => {
      previous.click();
      await Promise.resolve();
    });
    await until(() => subjectCalls.length === 7);
    await resolve(6, contextA, 'Fresh selected Previous');
    await until(() => relationCalls.length === 7 && host.textContent?.includes('Fresh selected Previous') === true);
    await render(contextA);
    expect(relationCalls[6]?.query).toMatchObject({ context: contextA });
    expect(relationCalls[6]?.query.cursor).toBeUndefined();
    expect(host.textContent).toContain('Fresh selected Previous');

    const targetLink = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.href.includes(target));
    if (!targetLink) throw new Error('The admitted relation target was not rendered');
    const targetUrl = new URL(targetLink.href);
    expect(targetUrl.searchParams.get('context')).toBe(contextA);
    expect(
      musicContextRouteSearch(Object.fromEntries(targetUrl.searchParams), 'en', {
        subjectId: target,
        pathname: targetUrl.pathname,
      })?.context,
    ).toBe(contextA);

    const streamSelect = host.querySelector<HTMLSelectElement>('#music-context-stream');
    if (!streamSelect) throw new Error('The admitted stream selector was not rendered');
    const alternateStream = [...streamSelect.options].find(
      (option) => option.value && option.value !== streamSelect.value,
    );
    if (!alternateStream) throw new Error('The released fixture needs a second relation stream');
    await act(async () => {
      streamSelect.value = alternateStream.value;
      streamSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(addressChanges.at(-1)).toEqual({ context: contextA, stream: alternateStream.value });
    await render(contextA);
    await until(() => subjectCalls.length === 8);
    const nextRelease = `sha256:${'b'.repeat(64)}`;
    relationTargetType = 'schema:Thing';
    await resolve(7, contextA, 'Changed source release', contextA, nextRelease);
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(host.textContent).not.toContain('Changed source release');
    expect(relationCalls).toHaveLength(8);
    expect(relationCalls.at(-1)?.query.context).toBe(contextA);
    const sourceRetry = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Retry this page'),
    );
    if (!sourceRetry) throw new Error('A source release change did not require a fresh read');
    await act(async () => sourceRetry.click());
    await until(() => subjectCalls.length === 9);
    await resolve(8, contextA, 'Fresh source release', contextA, nextRelease);
    await until(
      () => relationCalls.length === 9 && host.textContent?.includes('Fresh source release') === true,
      () => `subjects=${subjectCalls.length}; relations=${relationCalls.length}; view=${host.textContent}`,
    );
    expect(relationCalls.at(-1)?.query.context).toBe(contextA);
    expect(host.textContent).toContain('exact selected Context');
    const generalTarget = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.href.includes(target) && link.textContent?.includes('Open general Subject'),
    );
    if (!generalTarget) throw new Error('An unsupported target did not become an explicit general Subject visit');
    const generalVia = new URL(generalTarget.href).searchParams.get('via');
    if (!generalVia) throw new Error('The general target lost its compatible selected-Context return');
    expect(new URL(generalVia, 'https://site.test').searchParams.get('context')).toBe(contextA);

    await render(contextB);
    await until(() => subjectCalls.length === 10);
    await resolve(9, contextB, 'Mismatched Context', contextA);
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(host.textContent).not.toContain('Mismatched Context');
    expect(relationCalls).toHaveLength(9);

    await render(candidateContext);
    await until(() => subjectCalls.length === 11);
    await resolve(10, candidateContext, 'Explicit Global Context');
    await until(() => host.textContent?.includes('Explicit Global Context') === true);
    expect(relationCalls.at(-1)?.query.context).toBe(candidateContext);

    await render();
    await until(() => subjectCalls.length === 12);
    await resolve(11, candidateContext, 'Legacy Global Default');
    await until(() => host.textContent?.includes('Legacy Global Default') === true);
    expect(subjectCalls.at(-1)?.query.context).toBe(candidateContext);
    expect(relationCalls.at(-1)?.query.context).toBe(candidateContext);

    await render(contextA);
    await until(() => subjectCalls.length === 13);
    relationFailureOnce = true;
    await resolve(12, contextA, 'Unavailable selected Context');
    await until(() => host.querySelector('[role="alert"]') !== null);
    const retrySelected = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Retry this page'),
    );
    if (!retrySelected) throw new Error('An unavailable selected-Context page did not expose Retry');
    await act(async () => retrySelected.click());
    await until(() => subjectCalls.length === 14);
    await resolve(13, contextA, 'Retried selected Context');
    await until(() => relationCalls.length === 13 && host.textContent?.includes('Retried selected Context') === true);
    expect(subjectCalls.at(-1)?.query.context).toBe(contextA);
    expect(relationCalls.at(-1)?.query.context).toBe(contextA);

    const beforeUnsupportedRealm = subjectCalls.length;
    await render(undefined, realm);
    await until(() => host.textContent?.includes('cannot apply the selected Realm') === true);
    expect(subjectCalls).toHaveLength(beforeUnsupportedRealm);
    const freshGlobal = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Start a fresh Global reading'),
    );
    if (!freshGlobal) throw new Error('Unsupported Realm did not offer a deliberate fresh Global visit');
    expect(new URL(freshGlobal.href).searchParams.has('realm')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    stopObservation();
    queryClient.clear();
    host.remove();
  }
});
