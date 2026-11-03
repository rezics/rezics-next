import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import type {
  SubjectLibraryMutationResponse,
  SubjectLibrarySlotData,
  SubjectPublicCollectionsResult,
  SubjectSlotCollectionsResult,
} from '../src/library/subject-slot';
import * as start from '../.storybook/react-start';
import de from '../messages/de.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import fr from '../messages/fr.json';
import ja from '../messages/ja.json';
import ko from '../messages/ko.json';
import zhHans from '../messages/zh-Hans.json';
import zhHant from '../messages/zh-Hant.json';
import { createKernelClient } from '@rezics/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import {
  collectionPageWork,
  collectionWorkWithinBound,
  firstCollectionVisit,
  isCuratedWriteDestination,
  nextCollectionVisit,
  previousCollectionVisit,
  publicCountOf,
  replaceCollectionPage,
  SUBJECT_COLLECTION_PAGE_LIMIT,
} from '../src/library/subject-collection-journey';
import { loadSubjectLibraryCollections, loadSubjectPublicCollections } from '../src/library/subject-slot';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/ja/subjects/subject/reader', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Call<T> = ReturnType<typeof deferred<T>> & { data: Record<string, unknown> };
const members: Call<SubjectLibraryMutationResponse>[] = [];
const pickers: Call<SubjectSlotCollectionsResult>[] = [];
const publics: Call<SubjectPublicCollectionsResult>[] = [];
function hold<T>(calls: Call<T>[], input: { data: object; headers?: HeadersInit }) {
  const call = { ...deferred<T>(), data: structuredClone(input.data) as Record<string, unknown> };
  calls.push(call);
  return call.promise;
}
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/subject-slot-actions', () => ({
  mutateSubjectLibrarySlot: (input: Parameters<typeof hold>[1]) => hold(members, input),
  mutateSubjectLabelAction: async () => ({ ok: false, reason: 'unavailable' }),
  readSubjectLibraryCollections: (input: Parameters<typeof hold>[1]) => hold(pickers, input),
  readSubjectPublicCollections: (input: Parameters<typeof hold>[1]) => hold(publics, input),
  searchSubjectLabelsAction: async () => ({ state: 'unavailable', labels: [], next: null }),
  restoreSubjectLibrarySlot: async () => ({ ok: false, reason: 'unavailable' }),
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SubjectLibrarySlot } = await import('../src/library/subject-slot-view');
const { useSession } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
const { subjectHref } = await import('../src/subject/subject-href');
const { subjectSlotReturnTo } = await import('../src/library/subject-slot-return-context');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const subject = { id: id(1), type: 'schema:Book', label: 'Reader' };
const realm = id(9);
const canonical = subjectHref(subject, 'ja').href;
const reader = `${canonical}/credits?realm=${realm}&node=cast&cursor=next`;
const viewer = { state: 'signed-in' as const, subject: 'A', csrfToken: 'csrf-A' };
const publicRow = (page: number, index: number, multiplicity = 1) => ({
  id: `pub-${page}-${index}`,
  title: `Public ${page}-${index}`,
  curatorAccountId: 'curator',
  curator: { id: 'curator', handle: 'curator', displayName: 'Curator' },
  multiplicity,
});
const publicPage = (
  page: number,
  next: string | null,
  rows = SUBJECT_COLLECTION_PAGE_LIMIT,
  count: SubjectPublicCollectionsResult['count'] = { kind: 'exact' as const, value: 50 },
) => ({
  state: 'loaded' as const,
  collections: Array.from({ length: rows }, (_, index) => publicRow(page, index)),
  next,
  count,
});
const owned = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(100 + n),
  title: `Owned ${n}`,
  memberCount: 2,
  curatorAccountId: 'A',
  curator: null,
  membershipKind: 'curated' as const,
  ...extra,
});
const baseline = (): SubjectLibrarySlotData => ({
  session: 'signed-in',
  csrfToken: 'csrf-A',
  provenance: { viewer: 'A', csrfToken: 'csrf-A', subjectId: subject.id, readId: crypto.randomUUID() },
  entryAvailable: true,
  entry: { subjectId: subject.id, state: 'planned', revision: 1 },
  labels: [],
  collectionsLoaded: false,
  collections: null,
  collectionsNext: null,
  publicCollections: publicPage(1, 'cursor-2').collections,
  publicCollectionsNext: 'cursor-2',
  publicCollectionsCount: { kind: 'exact', value: 50 },
});
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let router: ReturnType<typeof createRouter>;
let props: ComponentProps<typeof SubjectLibrarySlot>;
let renderProps: ((next: ComponentProps<typeof SubjectLibrarySlot>) => void) | undefined;
function Journey() {
  const [current, setCurrent] = useState(props);
  renderProps = setCurrent;
  useSession();
  return <SubjectLibrarySlot {...current} />;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function paint(data = props.data) {
  props = { ...props, data };
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    renderProps?.(props);
    await tick();
  });
}
function button(text: string) {
  const node = [...window.document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(node).toBeDefined();
  return node as unknown as HTMLButtonElement;
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}
async function submit(selector: string) {
  await act(async () => {
    const form = window.document.querySelector(selector);
    expect(form).not.toBeNull();
    form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  members.length = pickers.length = publics.length = 0;
  props = { subject, locale: 'ja', data: baseline() };
  renderProps = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer);
  client.setQueryData(['exposure', 'viewer'], ['personal_library', 'collections']);
  client.setQueryData(['exposure', 'anonymous'], ['collections', 'personal_library']);
  notifyManager.setScheduler((callback) => callback());
  router = createRouter({
    routeTree: createRootRoute({ component: Journey }),
    history: createMemoryHistory({ initialEntries: [reader] }),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url).href,
      output: ({ url }) => localizeUrl(url, { locale: 'ja' }).href,
    },
  });
  await router.load();
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  mock.restore();
});
afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('native public count stays independent of page length, and missing count stays unknown', () => {
  expect(publicCountOf({ value: 50, exact: true })).toEqual({ kind: 'exact', value: 50 });
  expect(publicCountOf({ value: 0, exact: true })).toEqual({ kind: 'exact', value: 0 });
  expect(publicCountOf({ value: 20, exact: false })).toEqual({ kind: 'unknown' });
  expect(publicCountOf({ value: 20 })).toEqual({ kind: 'unknown' });
  expect(publicCountOf(undefined)).toEqual({ kind: 'unknown' });
  expect(isCuratedWriteDestination({ membershipKind: 'curated', memberCount: 3 })).toBe(true);
  expect(isCuratedWriteDestination({ membershipKind: 'dynamic', memberCount: 3 })).toBe(false);
  expect(isCuratedWriteDestination({ membershipKind: 'curated', builtinKind: 'watchlist' })).toBe(false);
  expect(isCuratedWriteDestination({ memberCount: 2 })).toBe(true);
  const first = firstCollectionVisit();
  const second = nextCollectionVisit(first, 'page-2');
  const third = nextCollectionVisit(second, 'page-3');
  expect(previousCollectionVisit(third)).toEqual({
    cursor: 'page-2',
    previousCursor: undefined,
    page: 2,
    canGoPrevious: false,
  });
});

test('eight launch locales distinguish public total, page rows, empty and exhausted states', () => {
  const keys = [
    'library_subject_public_collections',
    'library_subject_public_collections_unknown',
    'library_subject_page_rows',
    'library_subject_public_unavailable',
    'library_subject_no_public_collections',
    'library_subject_no_curated_collections',
    'library_subject_continuation_exhausted',
  ] as const;
  const catalogs = { en, de, es, fr, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };
  for (const catalog of Object.values(catalogs)) {
    for (const key of keys) expect(catalog[key].length).toBeGreaterThan(0);
    expect(catalog.library_subject_public_collections).toContain('{count}');
    expect(catalog.library_subject_public_collections_unknown).not.toContain('{count}');
    expect(catalog.library_subject_page_rows).toContain('{count}');
  }
});

test('a Subject reader continues three public pages, adds a later curated Collection, and returns', async () => {
  await paint();
  expect(host.textContent).toContain(m.library_subject_public_collections({ count: 50 }));
  expect(host.textContent).toContain(m.library_subject_page_rows({ count: 20 }));
  expect(host.textContent).not.toContain(m.library_subject_public_collections({ count: 20 }));
  expect(host.querySelector(`a[href="/ja/collections/pub-1-0"]`)).not.toBeNull();
  await click(m.library_subject_continuation_next());
  expect(publics[0]!.data).toEqual({ subjectId: subject.id, cursor: 'cursor-2' });
  await act(async () => publics[0]!.resolve(publicPage(2, 'cursor-3')));
  expect(host.textContent).toContain('Public 2-0');
  expect(host.textContent).not.toContain('Public 1-0');
  await click(m.library_subject_continuation_next());
  await act(async () => publics[1]!.resolve(publicPage(3, null, 10)));
  expect(host.textContent).toContain('Public 3-0');
  expect(host.textContent).toContain(m.library_subject_page_rows({ count: 10 }));
  expect(host.textContent).toContain(m.library_subject_continuation_exhausted());
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-add-to-collection]')!.click();
  });
  await submit('form:has(input[name="slot"])');
  expect(pickers[0]!.data).toEqual({ subjectId: subject.id });
  await act(async () =>
    pickers[0]!.resolve({
      state: 'loaded',
      collections: [owned(1), { ...owned(2), membershipKind: 'dynamic' }, { ...owned(3), builtinKind: 'inbox' }],
      next: 'owned-2',
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    }),
  );
  expect(host.textContent).toContain('Owned 1');
  expect(host.textContent).not.toContain('Owned 2');
  expect(host.textContent).not.toContain('Owned 3');
  await click(m.library_subject_continuation_next());
  expect(pickers[1]!.data).toEqual({ subjectId: subject.id, cursor: 'owned-2' });
  await act(async () =>
    pickers[1]!.resolve({
      state: 'loaded',
      collections: [owned(21)],
      next: 'owned-3',
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    }),
  );
  await click(m.library_subject_continuation_next());
  await act(async () =>
    pickers[2]!.resolve({
      state: 'loaded',
      collections: [owned(41)],
      next: null,
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    }),
  );
  await click('Owned 412');
  expect(members).toHaveLength(0);
  await click(m.library_subject_add_confirm());
  expect(members[0]!.data).toEqual({
    intent: 'member',
    subjectId: subject.id,
    collectionId: id(141),
    idempotencyKey: expect.any(String),
  });
  const sealed = members[0]!.data;
  await act(async () => members[0]!.resolve({ result: 'added' }));
  expect(host.textContent).toContain(m.library_subject_collection_added());
  expect(host.querySelector(`a[href="/ja/collections/${id(141)}"]`)).not.toBeNull();
  const returnLink = [...host.querySelectorAll('a')].find(
    (node) => node.textContent?.trim() === m.library_subject_return_reader(),
  );
  expect(returnLink?.getAttribute('href')).toBe(subjectSlotReturnTo(reader, subject, 'ja'));
  expect(returnLink?.getAttribute('href')).toContain('/ja/');
  expect(returnLink?.getAttribute('href')).toContain(`realm=${realm}`);
  expect(returnLink?.getAttribute('href')).toContain('node=cast');
  expect(returnLink?.getAttribute('href')).toContain('cursor=next');
  expect(sealed).toEqual(members[0]!.data);
});

test('empty continuing pages, expired cursors, denied add and original retry stay explicit', async () => {
  await paint({
    ...baseline(),
    publicCollections: [],
    publicCollectionsNext: 'sparse',
    publicCollectionsCount: { kind: 'unknown' },
  });
  expect(host.textContent).toContain(m.library_subject_public_collections_unknown());
  expect(host.textContent).not.toContain(m.library_subject_public_collections({ count: 0 }));
  expect(host.textContent).toContain(m.library_subject_public_empty_page());
  await click(m.library_subject_continuation_next());
  await act(async () =>
    publics[0]!.resolve({ state: 'expired', collections: null, next: null, count: { kind: 'unknown' } }),
  );
  expect(host.textContent).toContain(m.library_subject_continuation_expired());
  expect(host.textContent).not.toContain('Public 1-0');
  await click(m.library_subject_continuation_restart());
  expect(publics[1]!.data).toEqual({ subjectId: subject.id });
  await act(async () => publics[1]!.resolve(publicPage(1, null, 0, { kind: 'exact', value: 0 })));
  expect(host.textContent).toContain(m.library_subject_no_public_collections());
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-add-to-collection]')!.click();
  });
  await submit('form:has(input[name="slot"])');
  await act(async () =>
    pickers[0]!.resolve({
      state: 'loaded',
      collections: [owned(1)],
      next: 'later',
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    }),
  );
  await click('Owned 12');
  await click(m.library_subject_continuation_next());
  await act(async () =>
    pickers[1]!.resolve({
      state: 'loaded',
      collections: [owned(21)],
      next: null,
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    }),
  );
  expect(members).toHaveLength(0);
  await click(m.library_subject_add_confirm());
  const original = members[0]!.data;
  expect(original.collectionId).toBe(id(101));
  await act(async () => members[0]!.reject(new Error('lost member')));
  expect(host.textContent).toContain(m.library_subject_unavailable());
  await click(m.library_selection_retry());
  expect(members[1]!.data).toEqual(original);
  await act(async () => members[1]!.resolve({ result: 'dynamic' }));
  expect(host.textContent).toContain(m.library_subject_collection_dynamic());
  await click('Owned 212');
  await click(m.library_subject_add_confirm());
  expect(members[2]!.data.collectionId).toBe(id(121));
  await act(async () => members[2]!.resolve({ result: 'collection-full' }));
  expect(host.textContent).toContain(m.library_subject_collection_full());
  await click(m.library_subject_add_confirm());
  await act(async () => members[3]!.resolve({ result: 'added' }));
  await click(m.library_subject_add_confirm());
  await act(async () => members[4]!.resolve({ result: 'added' }));
  expect(members).toHaveLength(5);
  expect(members[4]!.data.collectionId).toBe(id(121));
  expect(members[4]!.data.idempotencyKey).not.toBe(members[3]!.data.idempotencyKey);
});

test('sign-out and Subject replacement retire private chooser work and keep a public list', async () => {
  await paint();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-add-to-collection]')!.click();
  });
  await submit('form:has(input[name="slot"])');
  await click(m.library_subject_continuation_next());
  const pendingPublic = publics[0]!;
  const pendingChooser = pickers[0]!;
  await act(async () => client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null }));
  expect(host.querySelector('[data-add-to-collection]')).toBeNull();
  expect(host.textContent).toContain(m.library_subject_public_collections({ count: 50 }));
  await act(async () => {
    pendingChooser.resolve({
      state: 'loaded',
      collections: [owned(1)],
      next: null,
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    });
    pendingPublic.resolve(publicPage(2, null));
  });
  expect(host.textContent).not.toContain('Owned 1');
  expect(host.textContent).not.toContain('Public 2-0');
  await act(async () => client.setQueryData(['session'], viewer));
  props = { ...props, subject: { ...subject, id: id(8) } };
  await paint({
    ...baseline(),
    provenance: { viewer: 'A', csrfToken: 'csrf-A', subjectId: id(8), readId: crypto.randomUUID() },
    publicCollections: [publicRow(9, 0)],
    publicCollectionsNext: null,
    publicCollectionsCount: { kind: 'exact', value: 1 },
  });
  expect(host.textContent).toContain('Public 9-0');
  expect(host.textContent).not.toContain('Public 1-0');
});

test('subject collection pages stay O(page) at 32, 256 and 2048 Collections', async () => {
  const recorded: { path: string; cursor: string | null }[] = [];
  let catalogue = 32;
  const client = withPlatformClosedRecognition(
    createKernelClient('https://kernel.example.test', {
      fetch: (async (input) => {
        const url = new URL(new Request(input).url);
        if (url.pathname.startsWith('/auth/')) return new Response(null, { status: 404 });
        recorded.push({ path: url.pathname, cursor: url.searchParams.get('cursor') });
        expect(url.searchParams.get('limit')).toBe('20');
        const offset =
          url.searchParams.get('cursor') === 'empty' ? catalogue : Number(url.searchParams.get('cursor') ?? 0);
        const remaining = Math.max(0, catalogue - offset);
        const rows = url.searchParams.get('cursor') === 'empty' ? 0 : Math.min(20, remaining);
        const next =
          url.searchParams.get('cursor') === 'empty'
            ? 'still'
            : offset + rows < catalogue
              ? String(offset + rows)
              : null;
        const collections = Array.from({ length: rows }, (_, index) => ({
          id: `row-${offset + index}`,
          curatorAccountId: 'owner',
          title: `Row ${offset + index}`,
          multiplicity: 1,
          membershipKind: 'curated',
          memberCount: 1,
          curator: { id: 'owner', handle: 'owner', displayName: 'Owner' },
        }));
        return Response.json({
          collections,
          next,
          count: { value: catalogue, exact: true },
        });
      }) as typeof fetch,
    }),
  );
  const stub = {
    async credential() {
      return { status: 'active' as const, subject: 'owner', accessToken: 'token', csrfToken: 'csrf' };
    },
  };
  const env = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'subject-collection-cost',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: { idFromName: (id: string) => id, get: () => stub } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;
  const request = new Request('https://site.example.test/en/subjects/subject', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  for (const size of [32, 256, 2048]) {
    catalogue = size;
    recorded.length = 0;
    const first = await loadSubjectPublicCollections(client, subject.id);
    expect(first.count).toEqual({ kind: 'exact', value: size });
    expect(first.collections).toHaveLength(20);
    const firstWork = collectionPageWork(
      replaceCollectionPage(undefined, first.collections ?? [], first.next, firstCollectionVisit(), first.count),
      1,
    );
    expect(collectionWorkWithinBound(firstWork, size)).toBe(true);
    const deepCursor = String(20 * Math.min(3, Math.floor((size - 1) / 20)));
    const deep = await loadSubjectPublicCollections(client, subject.id, deepCursor);
    expect(deep.collections!.length).toBeLessThanOrEqual(20);
    expect(deep.collections!.length).toBeGreaterThan(0);
    const empty = await loadSubjectPublicCollections(client, subject.id, 'empty');
    expect(empty.collections).toEqual([]);
    expect(empty.next).toBe('still');
    const restart = await loadSubjectPublicCollections(client, subject.id);
    expect(restart.collections).toHaveLength(20);
    expect(restart.collections![0]!.id).toBe('row-0');
    const ownedPage = await loadSubjectLibraryCollections(client, new Request(request), env, deepCursor);
    expect(ownedPage.collections).toHaveLength(Math.min(20, Math.max(0, size - Number(deepCursor))));
    const replacement = await loadSubjectPublicCollections(client, id(8));
    expect(replacement.collections).toHaveLength(20);
    expect(recorded.every((item) => item.path.includes('/collections'))).toBe(true);
    expect(firstWork.retainedRows).toBe(20);
    expect(firstWork.nativeRequests).toBe(1);
  }
});
