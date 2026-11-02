import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useState, type ComponentProps } from 'react';
import type {
  SubjectLibrarySlotData,
  SubjectLibraryMutationResponse,
  SubjectSlotCollectionsResult,
} from '../src/library/subject-slot';
import type { SubjectLabelMutationResult, searchSubjectLabels } from '../src/library/subject-labels';
import * as start from '../.storybook/react-start';

// UNRUN: composed owning UI regressions with the actual scoped viewer-exposure lifetime and BFF.
// Only transport outcomes are deferred fixtures; native/browser acceptance remains deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/subject/reader', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLDivElement: window.HTMLDivElement,
  HTMLSelectElement: window.HTMLSelectElement,
  PointerEvent: window.PointerEvent,
  KeyboardEvent: window.KeyboardEvent,
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
let actualViewer = 'A';
let actualCredential = 'csrf-A';
const sessionEnv = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'subject-library',
  WEBSITE_CLIENT_KEY: '{}',
  KERNEL_ORIGIN: 'https://kernel.test',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credentialIfFresh: async () => ({
        status: 'active',
        subject: actualViewer,
        csrfToken: actualCredential,
        accessToken: `native-${actualViewer}`,
      }),
    }),
  },
};
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () =>
    new Request('https://site.test/en/library', { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } }),
}));
mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  expect(new URL(request.url).pathname).toBe('/v1/platform/exposure');
  expect(request.headers.get('authorization')).toBe(`Bearer native-${actualViewer}`);
  return Response.json({ admitted });
}) as typeof fetch;
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
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
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
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
    renderProps?.(props);
    await tick();
  });
}
async function observe(owner: string, data?: SubjectLibrarySlotData) {
  actualViewer = owner;
  actualCredential = `csrf-${owner}`;
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
beforeEach(async () => {
  entries.length = labels.length = pickers.length = prefixes.length = pages.length = restores.length = undos.length = 0;
  props = { subject, locale: 'en', data: baseline() };
  renderProps = undefined;
  leaf = false;
  actualViewer = 'A';
  actualCredential = 'csrf-A';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer());
  // A foreign legacy global cache neither opens nor closes the scoped owner.
  client.setQueryData(['exposure', 'viewer'], []);
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
  globalThis.fetch = previousFetch;
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function scopedKey() {
  const snapshot = viewerExposureLifetime(client).getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Expected an enrolled observation');
  return viewerExposureQuery(snapshot.observation).queryKey;
}
async function settle() {
  for (let index = 0; index < 8; index++)
    await act(async () => {
      await tick();
    });
}
async function ready(data = baseline()) {
  await paint(data);
  await settle();
}
const retained = (node: unknown) => node as HTMLElement;

test('Complete Subject Library entry labels and member chooser authority preserves current authority and exact uncertain operations across observed replacement and ABA', async () => {
  await ready();
  expect(host.textContent).toContain('A private label');
  // Real native mappings: entry put/delete share personal_library, restore needs its exact operation.
  // A label gate changes only the label family, even before React has committed that cache replacement.
  const remove = button(m.library_subject_remove());
  const labelForm = retained(host.querySelector('[data-subject-label-remove]')!);
  const key = scopedKey();
  await act(async () => {
    client.setQueryData(key, { subject: 'A', admitted: admitted.filter((gate) => gate !== 'library_label.unassign') });
    labelForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    remove.click();
  });
  expect(labels).toHaveLength(0);
  expect(entries).toHaveLength(1);
  expect(host.querySelector('[data-add-to-collection]')).not.toBeNull();
  await act(async () =>
    entries[0]!.resolve({ result: 'cleared', entry: null, undo: { deletionId: id(60), revision: 11 } }),
  );
  expect(undos).toHaveLength(1);
  const undo = undos[0]!;
  await act(async () => {
    client.setQueryData(key, { subject: 'A', admitted: admitted.filter((gate) => gate !== 'library_entry.restore') });
    undo();
    client.setQueryData(key, { subject: 'A', admitted });
    undo();
  });
  expect(restores).toHaveLength(0);
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  // Returning identical admission does not revive the retired private seed or callbacks.
  await paint(props.data);
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  await ready(baseline());
  expect(host.querySelector('[data-library-entry]')).not.toBeNull();

  // An expected browser viewer is rejection-only, including an empty native entry and foreign Undo.
  for (const data of [
    { ...baseline('B'), entry: null },
    { ...baseline(), entry: null, provenance: { ...baseline().provenance!, subjectId: id(99) } },
    { ...baseline(), undo: { subjectId: id(99), deletionId: id(60), revision: 11 } },
    { ...baseline(), provenance: undefined },
  ]) {
    await paint(data);
    expect(host.querySelector('[data-library-entry]')).toBeNull();
    expect(host.querySelector('[data-subject-labels]')).toBeNull();
  }
  await ready(baseline());
  const currentRemove = button(m.library_subject_remove());
  await act(async () => {
    // A foreign actual scoped response cannot be repaired by the legacy global grant.
    client.setQueryData(['exposure', 'viewer'], admitted);
    client.setQueryData(key, { subject: 'B', admitted });
    currentRemove.click();
  });
  expect(entries).toHaveLength(1);
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  await act(async () => client.setQueryData(key, { subject: 'A', admitted }));
  await ready(baseline());
  const beforeError = button(m.library_subject_remove());
  await act(async () => {
    client
      .getQueryCache()
      .find({ queryKey: key, exact: true })!
      .setState({ status: 'error', error: new Error('exposure failed') });
    beforeError.click();
  });
  expect(entries).toHaveLength(1);
  expect(host.querySelector('[data-subject-labels]')).toBeNull();
  await act(async () => client.setQueryData(key, { subject: 'A', admitted }));
  await ready({
    ...baseline(),
    stateOptions: [
      { id: 'planned', label: { text: 'Plan to read', lang: 'en' } },
      { id: 'completed', label: { text: 'Finished reading', lang: 'en' } },
    ],
  });
  await act(async () => retained(host.querySelector('[role="combobox"]')).click());
  await act(async () => {
    const option = [...window.document.querySelectorAll('[role="option"]')].find((node) =>
      node.textContent?.includes('Finished reading'),
    );
    expect(option).toBeDefined();
    retained(option).click();
  });
  expect(entries.at(-1)!.data).toMatchObject({
    intent: 'entry',
    action: 'save',
    state: 'completed',
    revision: 7,
    incarnationId: id(10),
  });
  await act(async () =>
    entries.at(-1)!.resolve({
      result: 'saved',
      entry: { subjectId: subject.id, state: 'completed', revision: 8, incarnationId: id(10) },
    }),
  );
  expect(host.textContent).toContain(m.library_subject_saved());
  await openLabels();
  await act(async () => prefixes.at(-1)!.resolve(page('A', '', 'cursor-one')));
  await click(m.library_label_more());
  expect(pages.at(-1)!.data).toEqual({ query: '', cursor: 'cursor-one' });
  await act(async () =>
    pages.at(-1)!.resolve({
      ...page('A', '', null, 'wrong-cursor'),
      labels: [{ id: id(95), name: 'Wrong cursor choice', revision: 1 }],
    }),
  );
  expect(host.textContent).not.toContain('Wrong cursor choice');
  // A fresh query has its own page lifetime and is not blocked by the rejected continuation.
  await labelName('Existing');
  await act(async () => prefixes.at(-1)!.resolve(page('A', 'Existing')));
  await click('A choice');
  expect(labels.at(-1)!.data).toMatchObject({ intent: 'assign', labelId: id(21), idempotencyKey: id(32) });
  await act(async () => labels.at(-1)!.resolve({ ok: true, assignment: { id: id(20), revision: 10 } }));
  await openLabels();
  await labelName('New label');
  await act(async () =>
    prefixes.at(-1)!.resolve({
      state: 'loaded',
      labels: [],
      next: null,
      provenance: { viewer: 'A', csrfToken: 'csrf-A', query: 'New label' },
    }),
  );
  await submit('[data-subject-label-picker]');
  expect(labels.at(-1)!.data).toMatchObject({ intent: 'create-and-assign', name: 'New label', createKey: id(31) });
  expect(labels.at(-1)!.data.idempotencyKey).not.toBe(id(32));
  await act(async () =>
    labels.at(-1)!.resolve({
      ok: true,
      assignment: { id: id(25), revision: 1 },
      label: { id: id(26), name: 'New label', revision: 1 },
    }),
  );
  expect(host.textContent).toContain('New label');
  const form = host.querySelector('[data-subject-label-remove]:has(input[value="' + id(25) + '"])');
  await act(async () => retained(form).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(labels.at(-1)!.data).toMatchObject({ intent: 'unassign', assignmentId: id(25), revision: 1 });
  await act(async () =>
    labels.at(-1)!.resolve({ ok: true, assignment: { id: id(25), revision: 1 }, restoreRevision: 2 }),
  );
  await act(async () => undos.at(-1)!());
  expect(labels.at(-1)!.data).toMatchObject({ intent: 'restore', assignmentId: id(25), revision: 2 });
  await act(async () => labels.at(-1)!.resolve({ ok: true, assignment: { id: id(25), revision: 3 } }));
  expect(host.textContent).toContain('New label');
});

test('Retained callbacks and late A work cannot dispatch, expose data, invalidate or unlock B; address and viewer ABA never revive A', async () => {
  await ready();
  await click(m.library_subject_remove());
  await submit('[data-subject-label-remove]');
  await openLabels();
  await openCollections();
  await submit('form:has(input[name="slot"])');
  const aRemove = button(m.library_subject_remove());
  await observe('B', baseline('B'));
  await settle();
  expect(host.textContent).not.toContain('A private');
  await click(m.library_subject_remove());
  expect(entries).toHaveLength(2);
  expect(entries[1]!.csrf).toBe('csrf-B');
  const invalidation = spyOn(client, 'invalidateQueries');
  const routerInvalidation = spyOn(router, 'invalidate');
  await act(async () => {
    aRemove.click();
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
  expect(entries).toHaveLength(2);
  expect(undos).toHaveLength(0);
  expect(host.textContent).toContain('B private label');
  expect(host.textContent).not.toContain('A choice');
  expect(window.document.body.textContent).not.toContain('A private Collection');
  expect(invalidation).not.toHaveBeenCalled();
  expect(routerInvalidation).not.toHaveBeenCalled();
  // A's finally cannot release B's current in-flight exclusion.
  await click(m.library_subject_remove());
  expect(entries).toHaveLength(2);
  await act(async () => entries[1]!.resolve({ result: 'cleared', entry: null }));
  expect(host.textContent).toContain(m.library_subject_cleared());
  invalidation.mockRestore();
  routerInvalidation.mockRestore();

  await observe('A', baseline());
  await settle();
  await click(m.library_subject_remove());
  await act(async () =>
    entries[2]!.resolve({ result: 'cleared', entry: null, undo: { deletionId: id(61), revision: 12 } }),
  );
  const undo = undos.at(-1)!;
  await act(async () => {
    client.setQueryData(['session'], viewer('B'));
    client.setQueryData(['session'], viewer('A'));
    undo();
  });
  await settle();
  expect(restores).toHaveLength(0);
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  await ready(baseline());
  await click(m.library_subject_remove());
  await act(async () =>
    entries[3]!.resolve({ result: 'cleared', entry: null, undo: { deletionId: id(62), revision: 13 } }),
  );
  const beforeAddress = undos.at(-1)!;
  await act(async () => {
    await router.navigate({ href: `${canonical}/credits?node=cast&cursor=next` });
    await router.navigate({ href: canonical });
    beforeAddress();
  });
  expect(restores).toHaveLength(0);
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  await ready(baseline());
  const beforeSignOut = button(m.library_subject_remove());
  const count = entries.length;
  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
    beforeSignOut.click();
  });
  expect(entries).toHaveLength(count);
  expect(host.textContent).not.toContain('A private');
});

test('Healthy rotation and equivalent refresh preserve independent uncertain entry, label and member intent, revisions and keys without automatic dispatch', async () => {
  const data = { ...baseline(), collectionsLoaded: true, collections: [collection('A')] };
  await ready(data);
  await click(m.library_subject_remove());
  await submit('[data-subject-label-remove]');
  await openCollections();
  await click('A private Collection2');
  const entry = entries[0]!.data;
  const member = entries[1]!.data;
  const label = labels[0]!.data;
  await act(async () => {
    entries[0]!.reject(new Error('entry outcome unknown'));
    entries[1]!.reject(new Error('member outcome unknown'));
    labels[0]!.reject(new Error('label outcome unknown'));
  });
  // No mutation is retried by observation churn; current explicit retries use the exact commands.
  actualCredential = 'rotated';
  await act(async () => client.setQueryData(['session'], viewer('A', 'rotated')));
  await settle();
  await act(async () => client.setQueryData(scopedKey(), { subject: 'A', admitted: [...admitted] }));
  await settle();
  expect(entries).toHaveLength(2);
  expect(labels).toHaveLength(1);
  const retries = () =>
    [...host.querySelectorAll('button')].filter((node) => node.textContent?.trim() === m.library_selection_retry());
  expect(retries()).toHaveLength(3);
  await act(async () => {
    for (const node of retries()) retained(node).click();
  });
  expect(entries).toHaveLength(4);
  expect(labels).toHaveLength(2);
  expect(entries[2]!.data).toEqual(entry);
  expect(entries[3]!.data).toEqual(member);
  expect(labels[1]!.data).toEqual(label);
  expect([entries[2]!.csrf, entries[3]!.csrf, labels[1]!.csrf]).toEqual(['csrf-A', 'csrf-A', 'csrf-A']);
  // Already-dispatched writes keep their real result when an equivalent refresh retires the UI callback.
  await act(async () => client.setQueryData(scopedKey(), { subject: 'A', admitted: [...admitted] }));
  await act(async () => {
    entries[2]!.resolve({ result: 'cleared', entry: null });
    entries[3]!.resolve({ result: 'added' });
    labels[1]!.resolve({ ok: true, assignment: { id: id(20), revision: 9 }, restoreRevision: 12 });
  });
  await act(async () => {
    for (const node of retries()) retained(node).click();
  });
  expect(entries).toHaveLength(4);
  expect(labels).toHaveLength(2);
  expect(host.textContent).toContain(m.library_subject_collection_added());
  expect(host.querySelector('[data-subject-label-chip]')).toBeNull();
  // Exact entry Undo uncertainty also survives an admission outage without replaying automatically.
  await ready({
    ...baseline(),
    csrfToken: 'rotated',
    provenance: { ...baseline().provenance!, csrfToken: 'rotated' },
    undo: { subjectId: subject.id, deletionId: id(63), revision: 14 },
  });
  await submit('form:has(input[name="deletionId"])');
  const receipt = restores[0]!.data;
  await act(async () => restores[0]!.reject(new Error('restore outcome unknown')));
  await act(async () =>
    client
      .getQueryCache()
      .find({ queryKey: scopedKey(), exact: true })!
      .setState({
        status: 'error',
        error: new Error('authority unavailable'),
      }),
  );
  await act(async () => client.setQueryData(scopedKey(), { subject: 'A', admitted }));
  await ready({ ...baseline(), csrfToken: 'rotated', provenance: { ...baseline().provenance!, csrfToken: 'rotated' } });
  expect(restores).toHaveLength(1);
  await submit('form:has(input[name="deletionId"])');
  expect(restores[1]!.data).toEqual(receipt);
  expect(restores[1]!.csrf).toBe('rotated');
  await act(async () => restores[1]!.resolve({ ok: false, reason: 'stale' }));
});

test('The existing leaf accepts only actual scoped reads, partitions exact address/cursors and retires reads before commit without old seed revival', async () => {
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
  await ready();
  await act(async () => reads.at(-1)!.resolve(baseline()));
  await settle();
  expect(host.textContent).toContain('A private label');
  const key = scopedKey();
  await act(async () => {
    client.setQueryData(key, { subject: 'A', admitted: admitted.filter((gate) => gate !== 'personal_library') });
    client.setQueryData(key, { subject: 'A', admitted });
  });
  await settle();
  expect(host.querySelector('[data-library-entry]')).toBeNull();
  await act(async () => reads.at(-1)!.resolve(baseline()));
  await settle();
  const current = `${canonical}/credits?node=cast&cursor=deep&realm=${id(70)}`;
  await act(async () => {
    await router.navigate({ href: current });
  });
  await settle();
  const retired = reads.at(-1)!;
  await act(async () => {
    await router.navigate({ href: canonical });
  });
  await settle();
  await act(async () => reads.at(-1)!.resolve(baseline()));
  await settle();
  await act(async () =>
    retired.resolve({
      ...baseline(),
      labels: [{ id: id(91), labelId: id(92), revision: 1, name: 'Retired cursor label' }],
    }),
  );
  await settle();
  expect(host.textContent).not.toContain('Retired cursor label');
  expect(host.textContent).toContain('A private label');
});
