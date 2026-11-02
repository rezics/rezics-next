import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import type {
  SubjectLibrarySlotData,
  SubjectLibraryMutationResponse,
  SubjectSlotCollectionsResult,
} from '../src/library/subject-slot';
import type { SubjectLabelMutationResult, searchSubjectLabels } from '../src/library/subject-labels';
import type { SessionEnv } from '../src/session/client';
import * as start from '../.storybook/react-start';

// UNRUN: use the installed mounted DOM fixture and real owner/session/query composition, as in the
// existing current-viewer tests. Deferred BFF boundaries are not native, browser or visual proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/subject/reader', width: 1280, height: 900 });
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
type SearchPage = Awaited<ReturnType<typeof searchSubjectLabels>>;
type Call<T> = ReturnType<typeof deferred<T>> & { data: Record<string, unknown>; csrf: string | null };
const entries: Call<SubjectLibraryMutationResponse>[] = [];
const labels: Call<SubjectLabelMutationResult>[] = [];
const pickers: Call<SubjectSlotCollectionsResult>[] = [];
const prefixes: Call<SearchPage>[] = [];
const pages: Call<SearchPage>[] = [];
const restores: Call<
  Awaited<ReturnType<(typeof import('../src/library/subject-slot-actions'))['restoreSubjectLibrarySlot']>>
>[] = [];
const undos: (() => void)[] = [];
function hold<T>(calls: Call<T>[], input: { data: object; headers?: HeadersInit }) {
  const call = {
    ...deferred<T>(),
    data: structuredClone(input.data) as Record<string, unknown>,
    csrf: new Headers(input.headers).get('x-csrf-token'),
  };
  calls.push(call);
  return call.promise;
}
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/subject-slot-actions', () => ({
  mutateSubjectLibrarySlot: (input: Parameters<typeof hold>[1]) => hold(entries, input),
  mutateSubjectLabelAction: (input: Parameters<typeof hold>[1]) => hold(labels, input),
  readSubjectLibraryCollections: (input: Parameters<typeof hold>[1]) => hold(pickers, input),
  searchSubjectLabelsAction: (input: Parameters<typeof hold>[1]) => hold(prefixes, input),
  restoreSubjectLibrarySlot: (input: Parameters<typeof hold>[1]) => hold(restores, input),
}));
mock.module('../src/library/labels-actions', () => ({
  readSubjectLabelPage: (input: Parameters<typeof hold>[1]) => hold(pages, input),
}));
mock.module('@rezics/ui/undo-toast', () => ({
  undoToast: (_message: string, callback: () => void) => undos.push(callback),
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SubjectLibrarySlot } = await import('../src/library/subject-slot-view');
const { SubjectLibraryLeaf } = await import('../src/features/pages/subject-library-leaf');
const queries = await import('../src/features/pages/subject-queries');
const { useSession } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
const { subjectHref } = await import('../src/subject/subject-href');
const { loadSubjectLibrarySlot, loadSubjectLibraryCollections } = await import('../src/library/subject-slot');
const { searchSubjectLabels: realSearch } = await import('../src/library/subject-labels');
const { createKernelClient } = await import('@rezics/client');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const subject = { id: id(1), type: 'schema:Book', label: 'Reader' };
const canonical = subjectHref(subject, 'en').href;
const viewer = (subject = 'A', csrfToken = `csrf-${subject}`) => ({ state: 'signed-in' as const, subject, csrfToken });
const admitted = [
  'personal_library',
  'collections',
  'library_entry.restore',
  'library_label.assignment_list',
  'library_label.list',
  'library_label.create',
  'library_label.assign',
  'library_label.unassign',
];
const collection = (owner: string) => ({
  id: id(owner === 'A' ? 41 : 42),
  title: `${owner} private Collection`,
  memberCount: 2,
  curatorAccountId: owner,
  curator: null,
});
const baseline = (owner = 'A'): SubjectLibrarySlotData => ({
  session: 'signed-in',
  csrfToken: `csrf-${owner}`,
  provenance: { viewer: owner, csrfToken: `csrf-${owner}`, subjectId: subject.id, readId: crypto.randomUUID() },
  entryAvailable: true,
  entry: { subjectId: subject.id, state: 'planned', revision: 7, incarnationId: id(10) },
  entryStateLabel: `${owner} private state`,
  stateOptions: [],
  labels: [{ id: id(20), labelId: id(21), name: `${owner} private label`, revision: 9 }],
  labelRemoveKeys: { [id(20)]: id(30) },
  labelCreateKey: id(31),
  labelAssignKey: id(32),
  labelUndoKey: id(33),
  collectionsLoaded: false,
  collections: null,
  publicCollections: [
    {
      id: id(50),
      title: 'Public Collection',
      curatorAccountId: id(51),
      curator: { id: id(51), handle: 'public-curator', displayName: 'Public curator' },
      multiplicity: 3,
    },
  ],
  publicCollectionsNext: null,
});
const page = (owner: string, query = '', next: string | null = null, cursor?: string): SearchPage => ({
  state: 'loaded',
  labels: [{ id: id(21), name: `${owner} choice`, revision: 1 }],
  next,
  provenance: { viewer: owner, csrfToken: `csrf-${owner}`, query, ...(cursor ? { cursor } : {}) },
});
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let router: ReturnType<typeof createRouter>;
let props: ComponentProps<typeof SubjectLibrarySlot>;
let renderProps: ((next: ComponentProps<typeof SubjectLibrarySlot>) => void) | undefined;
let leaf = false;
function Journey() {
  const [current, setCurrent] = useState(props);
  renderProps = setCurrent;
  const session = useSession();
  return leaf ? (
    <SubjectLibraryLeaf
      frame={{
        id: current.subject.id,
        type: current.subject.type,
        title: { text: current.subject.label },
        summary: null,
      }}
      locale={current.locale}
      session={session}
    />
  ) : (
    <SubjectLibrarySlot {...current} />
  );
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
async function observe(owner: string, data?: SubjectLibrarySlotData) {
  await act(async () => {
    client.setQueryData(['session'], viewer(owner));
    await tick();
  });
  if (data) await paint(data);
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
async function openLabels() {
  await act(async () => {
    const details = host.querySelector<HTMLDetailsElement>('[data-subject-label-picker-details]')!;
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 270));
  });
}
async function labelName(value: string) {
  await act(async () => {
    const input = host.querySelector('input[name="name"]')!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 270));
  });
}
async function openCollections() {
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-add-to-collection]')!.click();
  });
}
function noPrivate(owner: string, publicAdmitted = true) {
  expect(window.document.body.textContent).not.toContain(`${owner} private`);
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  expect(host.querySelector('[data-subject-labels]')).toBeNull();
  expect(host.querySelector('[data-add-to-collection]')).toBeNull();
  if (publicAdmitted) expect(host.textContent).toContain('Public Collection');
}
beforeEach(async () => {
  entries.length = labels.length = pickers.length = prefixes.length = pages.length = restores.length = undos.length = 0;
  props = { subject, locale: 'en', data: baseline() };
  renderProps = undefined;
  leaf = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer());
  client.setQueryData(['exposure', 'viewer'], admitted);
  client.setQueryData(['exposure', 'anonymous'], ['collections', 'personal_library']);
  notifyManager.setScheduler((callback) => callback());
  router = createRouter({
    routeTree: createRootRoute({ component: Journey }),
    history: createMemoryHistory({ initialEntries: [canonical] }),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url).href,
      output: ({ url }) => localizeUrl(url, { locale: 'en' }).href,
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

test('Actual same-read provenance, including empty results, is required by the mounted owner and retired immediately on observed replacement', async () => {
  const nativeReads: Request[] = [];
  let credentialReads = 0;
  let state = 'active';
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'subject-library',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => {
          credentialReads++;
          return state === 'active'
            ? { status: 'active', subject: 'A', csrfToken: 'csrf-A', accessToken: 'native-A' }
            : { status: state };
        },
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const native = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      nativeReads.push(request);
      const url = new URL(request.url);
      if (url.pathname === `/v1/subjects/${subject.id}/collections`)
        return Response.json({ collections: baseline().publicCollections, next: null });
      expect(request.headers.get('authorization')).toBe('Bearer native-A');
      if (url.pathname === `/v1/libraryEntries/${subject.id}`) return new Response(null, { status: 404 });
      if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted });
      if (url.pathname === '/v1/libraryLabelAssignments') return Response.json({ assignments: [] });
      if (url.pathname === '/v1/collections') return Response.json({ collections: [collection('A')], next: null });
      if (url.pathname === '/v1/libraryLabels') return Response.json({ labels: [], next: null });
      throw new Error(`Unexpected private read ${request.url}`);
    }) as typeof fetch,
  });
  const request = () =>
    new Request(`https://site.test${canonical}`, { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } });
  const loaded = await loadSubjectLibrarySlot(native, request(), env, subject.id);
  expect(credentialReads).toBe(1);
  expect(loaded.provenance).toMatchObject({ viewer: 'A', csrfToken: 'csrf-A', subjectId: subject.id });
  expect(loaded.entry).toBeNull();
  const picker = await loadSubjectLibraryCollections(native, request(), env);
  expect(picker.provenance).toEqual({ viewer: 'A', csrfToken: 'csrf-A' });
  const searched = await realSearch({
    client: native,
    request: request(),
    sessionEnv: env,
    query: 'literal',
    cursor: 'signed-next',
  });
  expect(searched.provenance).toEqual({ viewer: 'A', csrfToken: 'csrf-A', query: 'literal', cursor: 'signed-next' });
  expect(credentialReads).toBe(3);
  state = 'unavailable';
  nativeReads.length = 0;
  await loadSubjectLibrarySlot(native, request(), env, subject.id);
  await loadSubjectLibraryCollections(native, request(), env);
  await realSearch({ client: native, request: request(), sessionEnv: env, query: '' });
  expect(nativeReads.map((request) => new URL(request.url).pathname)).toEqual([
    `/v1/subjects/${subject.id}/collections`,
  ]);
  await paint({ ...baseline(), ...loaded, collections: picker.collections, collectionsLoaded: true });
  expect(host.querySelector('[data-subject-labels]')).not.toBeNull();
  await paint({ ...props.data, provenance: { ...loaded.provenance!, viewer: 'B' } });
  noPrivate('A');
  const { provenance: _missing, ...missing } = baseline();
  await paint(missing);
  noPrivate('A');
  await paint({ ...baseline(), entryAvailable: false, entry: null });
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  expect(host.textContent).toContain('A private label');
  await paint({ ...baseline(), labels: null });
  expect(host.querySelector('[data-subject-labels]')).toBeNull();
  expect(host.querySelector('[data-library-entry]')).not.toBeNull();
  expect(host.querySelector('[data-add-to-collection]')).not.toBeNull();
  await paint(baseline());
  await openLabels();
  await openCollections();
  await act(async () => {
    client.setQueryData(['session'], { state: 'unknown', csrfToken: null });
  });
  noPrivate('A', false);
  expect(prefixes).toHaveLength(1);
  expect(entries).toHaveLength(0);
});

test('Current B can write before A entry, prefix, collection picker and unassign finish; late A results cannot change B, invalidate it or create Undo', async () => {
  await paint();
  await click(m.library_subject_remove());
  await openLabels();
  await submit('[data-subject-label-remove]');
  await openCollections();
  await submit('form:has(input[name="slot"])');
  expect(entries[0]!.data).toEqual({
    subjectId: subject.id,
    intent: 'entry',
    action: 'clear',
    revision: 7,
    incarnationId: id(10),
    idempotencyKey: expect.any(String),
  });
  expect(labels[0]!.data).toEqual({
    intent: 'unassign',
    subjectId: subject.id,
    labelId: id(21),
    assignmentId: id(20),
    revision: 9,
    idempotencyKey: id(30),
  });
  await observe('B');
  noPrivate('A');
  await paint(baseline('B'));
  await click(m.library_subject_remove());
  expect(entries).toHaveLength(2);
  expect(entries[1]!.csrf).toBe('csrf-B');
  await act(async () => {
    entries[1]!.resolve({ result: 'cleared', entry: null });
  });
  expect(host.textContent).toContain(m.library_subject_cleared());
  const invalidation = spyOn(client, 'invalidateQueries');
  const routerInvalidation = spyOn(router, 'invalidate');
  await act(async () => {
    entries[0]!.resolve({ result: 'cleared', entry: null, undo: { deletionId: id(60), revision: 11 } });
    labels[0]!.resolve({ ok: true, assignment: { id: id(20), revision: 9 }, restoreRevision: 12 });
    prefixes[0]!.resolve(page('A'));
    pickers[0]!.resolve({
      state: 'loaded',
      collections: [collection('A')],
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    });
    await tick();
  });
  expect(window.document.body.textContent).not.toContain('A private');
  expect(host.textContent).toContain('B private label');
  expect(host.textContent).toContain(m.library_subject_cleared());
  expect(invalidation).not.toHaveBeenCalled();
  expect(routerInvalidation).not.toHaveBeenCalled();
  expect(undos).toHaveLength(0);
  expect(restores).toHaveLength(0);
  expect(host.querySelector('a[href="/en/collections/' + id(50) + '"]')).not.toBeNull();
  expect(host.querySelector('a[href="/en/@public-curator"]')?.textContent).toContain('Public curator');
});

test('The complete mounted Subject Library workflow accepts only its actual current viewer and address and retires old entry label picker member and Undo continuations', async () => {
  await paint();
  await click(m.library_subject_remove());
  const original = entries[0]!.data;
  await act(async () => {
    entries[0]!.reject(new Error('Unknown outcome'));
  });
  await act(async () => {
    client.setQueryData(['session'], viewer('A', 'rotated'));
  });
  await click(m.library_selection_retry());
  expect(entries[1]!.data).toEqual(original);
  expect(entries[1]!.csrf).toBe('csrf-A');
  await act(async () => {
    entries[1]!.resolve({ result: 'cleared', entry: null, undo: { deletionId: id(60), revision: 11 } });
  });
  expect(undos).toHaveLength(1);
  await act(async () => {
    undos[0]!();
  });
  expect(restores[0]!.data).toEqual({ subjectId: subject.id, deletionId: id(60), revision: 11 });
  const a = { ...baseline(), csrfToken: 'rotated', provenance: { ...baseline().provenance!, csrfToken: 'rotated' } };
  await paint(a);
  await submit('[data-subject-label-remove]');
  await act(async () => {
    labels[0]!.resolve({ ok: true, assignment: { id: id(20), revision: 9 }, restoreRevision: 12 });
    await tick();
  });
  const restoreLabel = undos[1]!;
  await act(async () => {
    restoreLabel();
  });
  expect(labels[1]!.data).toEqual({
    intent: 'restore',
    subjectId: subject.id,
    labelId: id(21),
    assignmentId: id(20),
    revision: 12,
    idempotencyKey: expect.any(String),
  });
  await act(async () => {
    labels[1]!.resolve({ ok: true, assignment: { id: id(20), revision: 13 } });
  });
  expect(host.textContent).toContain('A private label');
  await openLabels();
  await labelName('New current label');
  await act(async () => {
    prefixes.at(-1)!.resolve({
      state: 'loaded',
      labels: [],
      next: null,
      provenance: { viewer: 'A', csrfToken: 'rotated', query: 'New current label' },
    });
  });
  await submit('[data-subject-label-picker]');
  expect(labels[2]!.data).toEqual({
    intent: 'create-and-assign',
    subjectId: subject.id,
    name: 'New current label',
    createKey: id(31),
    idempotencyKey: id(32),
  });
  expect(labels[2]!.csrf).toBe('rotated');
  await act(async () => {
    labels[2]!.resolve({
      ok: true,
      assignment: { id: id(25), revision: 1 },
      label: { id: id(26), name: 'New current label', revision: 1 },
    });
  });
  expect(host.textContent).toContain('New current label');
  await openCollections();
  await submit('form:has(input[name="slot"])');
  await act(async () => {
    pickers[0]!.resolve({
      state: 'loaded',
      collections: [collection('A')],
      provenance: { viewer: 'A', csrfToken: 'rotated' },
    });
  });
  await click('A private Collection2');
  expect(entries[2]!.data).toEqual({
    intent: 'member',
    subjectId: subject.id,
    collectionId: id(41),
    idempotencyKey: expect.any(String),
  });
  await act(async () => {
    entries[2]!.resolve({ result: 'added' });
  });
  expect(host.textContent).toContain(m.library_subject_collection_added());
  await click('A private Collection2');
  await openLabels();
  await act(async () => {
    prefixes
      .at(-1)!
      .resolve({ ...page('A', '', 'signed-page'), provenance: { viewer: 'A', csrfToken: 'rotated', query: '' } });
  });
  await click(m.library_label_more());
  expect(pages[0]!.data).toEqual({ query: '', cursor: 'signed-page' });
  await act(async () => {
    // Both transitions are observed even though React can batch them into one render.
    client.setQueryData(['session'], viewer('B'));
    client.setQueryData(['session'], viewer('A', 'rotated'));
  });
  noPrivate('A');
  await paint({ ...a, provenance: { ...a.provenance!, readId: crypto.randomUUID() } });
  const invalidation = spyOn(client, 'invalidateQueries');
  const routerInvalidation = spyOn(router, 'invalidate');
  const before = labels.length;
  await act(async () => {
    undos[0]!();
    restoreLabel();
    restores[0]!.resolve({ ok: false, reason: 'stale' });
    entries[3]!.resolve({ result: 'added' });
    pages[0]!.resolve({
      ...page('A', '', null, 'signed-page'),
      labels: [{ id: id(22), name: 'Retired page choice', revision: 1 }],
    });
    await tick();
  });
  expect(restores).toHaveLength(1);
  expect(labels).toHaveLength(before);
  expect(host.textContent).not.toContain('Retired page choice');
  expect(host.textContent).not.toContain(m.library_subject_collection_added());
  expect(invalidation).not.toHaveBeenCalled();
  expect(routerInvalidation).not.toHaveBeenCalled();
});

test('The mounted leaf partitions admission and return-address ABA reads and requires fresh same-reader acceptance', async () => {
  const reads: ReturnType<typeof deferred<SubjectLibrarySlotData>>[] = [];
  const source = queries.subjectLibraryQuery;
  spyOn(queries, 'subjectLibraryQuery').mockImplementation((...args) => ({
    ...source(...args),
    queryFn: () => {
      const pending = deferred<SubjectLibrarySlotData>();
      reads.push(pending);
      return pending.promise;
    },
  }));
  leaf = true;
  await paint();
  expect(reads).toHaveLength(1);
  await act(async () => {
    reads[0]!.resolve(baseline());
    await tick();
  });
  expect(host.textContent).toContain('A private label');
  await act(async () => {
    client.setQueryData(
      ['exposure', 'viewer'],
      admitted.filter((gate) => gate !== 'personal_library'),
    );
    client.setQueryData(['exposure', 'viewer'], admitted);
    await tick();
  });
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  expect(host.textContent).toContain('A private label');
  expect(reads).toHaveLength(2);
  await act(async () => {
    reads[1]!.resolve(baseline());
    await tick();
  });
  expect(host.querySelector('[data-library-entry]')).not.toBeNull();
  const address = `${canonical}/credits?node=cast&cursor=next`;
  await act(async () => {
    await router.navigate({ href: address });
    await tick();
  });
  expect(reads).toHaveLength(3);
  await act(async () => {
    await router.navigate({ href: canonical });
    await tick();
  });
  expect(reads).toHaveLength(4);
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  await act(async () => {
    reads[3]!.resolve(baseline());
    await tick();
  });
  expect(host.textContent).toContain('A private label');
  await act(async () => {
    reads[2]!.resolve({
      ...baseline(),
      entryStateLabel: 'Retired address state',
      labels: [{ id: id(23), labelId: id(24), revision: 1, name: 'Retired address label' }],
    });
    await tick();
  });
  expect(host.textContent).not.toContain('Retired address');
  expect(host.textContent).toContain('A private label');
});


test('A tokenless reader sees current native slot facts and can retry reads; token arrival never submits commands', async () => {
  const reads: ReturnType<typeof deferred<SubjectLibrarySlotData>>[] = [];
  const source = queries.subjectLibraryQuery;
  spyOn(queries, 'subjectLibraryQuery').mockImplementation((...args) => ({
    ...source(...args),
    queryFn: () => {
      const read = deferred<SubjectLibrarySlotData>();
      reads.push(read);
      return read.promise;
    },
  }));
  leaf = true;
  await act(async () => client.setQueryData(['session'], { ...viewer(), csrfToken: null }));
  await paint();
  await act(async () => reads.at(-1)!.reject(new Error('read unavailable')));
  await click(m.library_selection_retry());
  const data = { ...baseline(), result: 'conflict' as const, collectionsLoaded: true, collections: [collection('A')] };
  await act(async () => reads.at(-1)!.resolve(data));
  expect(host.textContent).toContain('A private state');
  expect(host.textContent).toContain('A private label');
  expect(host.textContent).toContain(m.library_conflict());
  expect(button(m.library_subject_remove()).disabled).toBe(true);
  await submit('[data-subject-label-remove]');
  await openCollections();
  expect(button('A private Collection2').disabled).toBe(true);
  expect(entries).toHaveLength(0);
  expect(labels).toHaveLength(0);
  await act(async () => client.setQueryData(['session'], viewer('A', 'arrived')));
  await act(async () => reads.at(-1)!.resolve({ ...data, provenance: { ...data.provenance!, readId: crypto.randomUUID() } }));
  expect(entries).toHaveLength(0);
  expect(labels).toHaveLength(0);
  await click(m.library_subject_remove());
  expect(entries[0]!.csrf).toBe('arrived');
  await act(async () => entries[0]!.reject(new Error('write unknown')));
  await act(async () => client.setQueryData(['session'], { ...viewer(), csrfToken: null }));
  await act(async () => reads.at(-1)!.resolve({ ...data, provenance: { ...data.provenance!, readId: crypto.randomUUID() } }));
  const stale = button(m.library_selection_retry());
  await click(m.library_selection_retry());
  expect(entries[1]!.csrf).toBe('arrived');
  expect(entries[1]!.data).toEqual(entries[0]!.data);
  await act(async () => client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null }));
  await act(async () => stale.click());
  expect(entries).toHaveLength(2);
  noPrivate('A', false);
});
