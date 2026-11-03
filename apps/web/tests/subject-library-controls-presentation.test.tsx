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

// UNRUN: mounted semantics and transport regressions through the actual owner. Happy DOM has no
// layout engine: these assertions do not establish phone geometry, focus styling or native acceptance.
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
const exposureReads: Request[] = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  exposureReads.push(request);
  expect(new URL(request.url).pathname).toBe('/v1/platform/exposure');
  expect(request.headers.get('authorization')).toBe(`Bearer native-${actualViewer}`);
  return Response.json({ admitted });
}) as typeof fetch;
mock.module('../src/library/subject-slot-actions', () => ({
  mutateSubjectLibrarySlot: (input: Parameters<typeof hold>[1]) => hold(entries, input),
  mutateSubjectLabelAction: (input: Parameters<typeof hold>[1]) => hold(labels, input),
  readSubjectLibraryCollections: (input: Parameters<typeof hold>[1]) => hold(pickers, input),
  readSubjectPublicCollections: async () => ({
    state: 'unavailable',
    collections: null,
    next: null,
    count: { kind: 'unknown' },
  }),
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
const longLabel = 'Unbroken'.repeat(25);
const multiwordLabel = 'A shared reading label with a complete name '.repeat(5).slice(0, 200);
const longCollection = 'UnbrokenCollection'.repeat(10);
const multiwordCollection = 'Winter reading shared across the whole family '.repeat(4);
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
  labels: [
    { id: id(20), labelId: id(21), name: longLabel, revision: 9 },
    { id: id(23), labelId: id(24), name: multiwordLabel, revision: 4 },
  ],
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
function Journey() {
  const [current, setCurrent] = useState(props);
  renderProps = setCurrent;
  return <SubjectLibrarySlot {...current} />;
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
  exposureReads.length = 0;
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

function fields(form: Element) {
  return Object.fromEntries(
    [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]),
  );
}
async function focusOnly(nodes: HTMLElement[]) {
  const before = [entries.length, labels.length, pickers.length, prefixes.length, pages.length, exposureReads.length];
  await act(async () => {
    for (const node of nodes) {
      node.focus();
      expect(window.document.activeElement).toBe(node);
    }
    await tick();
  });
  expect([entries.length, labels.length, pickers.length, prefixes.length, pages.length, exposureReads.length]).toEqual(
    before,
  );
}
const choices = () => [
  { ...collection('A'), title: multiwordCollection, memberCount: 2 },
  { ...collection('A'), id: id(43), title: longCollection, memberCount: 0 },
  { ...collection('A'), id: id(44), title: 'A private Collection', memberCount: 2 },
];
async function resolveSearch(query = '') {
  await act(async () =>
    prefixes.at(-1)!.resolve({
      ...page('A', query),
      labels: [
        { id: id(27), name: multiwordLabel, revision: 5 },
        { id: id(28), name: longLabel, revision: 6 },
      ],
    }),
  );
}

test('Complete Collection names, native order, literal zero and exact button text survive render and focus without loading or writing', async () => {
  await ready();
  expect([entries.length, labels.length, pickers.length, prefixes.length]).toEqual([0, 0, 0, 0]);
  await focusOnly([retained(host.querySelector('[data-add-to-collection]'))]);
  await openCollections();
  expect(pickers).toHaveLength(0);
  await submit('form:has(input[name="slot"])');
  expect(pickers[0]!.data).toEqual({ subjectId: subject.id });
  await act(async () =>
    pickers[0]!.resolve({
      state: 'loaded',
      collections: choices(),
      provenance: { viewer: 'A', csrfToken: 'csrf-A' },
    }),
  );
  const buttons = choices().map((row) => button(row.title + row.memberCount));
  expect(buttons.map((node) => node.textContent)).toEqual([
    multiwordCollection + '2',
    longCollection + '0',
    'A private Collection2',
  ]);
  expect(buttons.map((node) => node.parentElement)).toEqual([...buttons[0]!.closest('ul')!.children]);
  for (const node of buttons) {
    expect(node.tagName).toBe('BUTTON');
    expect(node.getAttribute('type')).toBe('button');
    expect(node.querySelector('a')).toBeNull();
    expect(node.querySelector('[title], [aria-hidden="true"]')).toBeNull();
  }
  await focusOnly(buttons);
  await click(longCollection + '0');
  await click(m.library_subject_add_confirm());
  const original = entries[0]!.data;
  expect(original).toEqual({
    intent: 'member',
    subjectId: subject.id,
    collectionId: id(43),
    idempotencyKey: expect.any(String),
  });
  expect(entries[0]!.csrf).toBe('csrf-A');
  await act(async () => entries[0]!.reject(new Error('Unknown member outcome')));
  expect(host.textContent).toContain(m.library_subject_unavailable());
  await focusOnly([button(m.library_selection_retry())]);
  await click(m.library_selection_retry());
  expect(entries[1]!.data).toEqual(original);
  await act(async () => entries[1]!.resolve({ result: 'added' }));
  expect(host.textContent).toContain(m.library_subject_collection_added());
});

test('Two 200-character Label identities keep independent shelf anchors and remove forms with original native operands and inline Undo revision', async () => {
  await ready();
  expect(longLabel.length).toBe(200);
  expect(multiwordLabel.length).toBe(200);
  const chips = [...host.querySelectorAll<HTMLElement>('[data-subject-label-chip]')];
  expect(chips.map((chip) => chip.querySelector('a')!.textContent)).toEqual([longLabel, multiwordLabel]);
  const link = chips[0]!.querySelector('a')!;
  const form = chips[0]!.querySelector('form')!;
  const remove = form.querySelector('button')!;
  expect(link.getAttribute('href')).toBe(`/en/library?label=${id(21)}`);
  expect(link.querySelector('button, form')).toBeNull();
  expect(form.closest('a')).toBeNull();
  expect(remove.getAttribute('aria-label')).toBe(m.library_subject_label_remove({ name: longLabel }));
  expect(form.getAttribute('action')).toBe(canonical);
  expect(form.getAttribute('method')).toBe('post');
  expect(fields(form)).toEqual({
    intent: 'unassign',
    subjectId: subject.id,
    labelId: id(21),
    assignmentId: id(20),
    idempotencyKey: id(30),
    revision: '9',
    csrf_token: 'csrf-A',
  });
  await focusOnly([link, remove, retained(host.querySelector('[data-subject-label-picker-details] summary'))]);
  link.addEventListener('click', (event) => event.preventDefault(), { once: true });
  await act(async () => link.click());
  expect(labels).toHaveLength(0);
  await submit('[data-subject-label-remove]');
  expect(labels[0]!.data).toEqual({
    intent: 'unassign',
    subjectId: subject.id,
    labelId: id(21),
    assignmentId: id(20),
    idempotencyKey: id(30),
    revision: 9,
  });
  expect(remove.disabled).toBe(true);
  expect(labels[0]!.csrf).toBe('csrf-A');
  await act(async () => labels[0]!.resolve({ ok: true, assignment: { id: id(20), revision: 9 }, restoreRevision: 12 }));
  expect(host.querySelectorAll('[data-subject-label-chip]')).toHaveLength(1);
  expect(host.textContent).toContain(multiwordLabel);
  expect(undos).toHaveLength(1);
  const undo = host.querySelector('[data-label-undo]')!;
  const undoFields = fields(undo);
  expect(undo.getAttribute('method')).toBe('post');
  expect(undo.getAttribute('action')).toBe(canonical);
  expect(undoFields).toEqual({
    intent: 'restore',
    subjectId: subject.id,
    labelId: id(21),
    assignmentId: id(20),
    revision: '12',
    csrf_token: 'csrf-A',
    idempotencyKey: expect.any(String),
  });
  expect(undoFields.idempotencyKey).not.toBe(id(30));
  await focusOnly([button(m.library_subject_label_undo())]);
  await submit('[data-label-undo]');
  expect(labels[1]!.data).toEqual({
    intent: 'restore',
    subjectId: subject.id,
    labelId: id(21),
    assignmentId: id(20),
    revision: 12,
    idempotencyKey: undoFields.idempotencyKey,
  });
  await act(async () =>
    labels[1]!.resolve({
      ok: true,
      assignment: { id: id(20), revision: 13 },
      label: { id: id(21), name: longLabel, revision: 1 },
    }),
  );
  expect(host.textContent).toContain(longLabel);
  expect(host.querySelector('[data-label-undo]')).toBeNull();
});

test('Existing and create Label choices expose their whole names, keep search order, cancel independently and dispatch only the chosen immutable command', async () => {
  await ready();
  await openLabels();
  await resolveSearch();
  const list = host.querySelector('ul[aria-label]')!;
  expect([...list.querySelectorAll('button')].map((node) => node.textContent)).toEqual([multiwordLabel, longLabel]);
  const picker = host.querySelector('[data-subject-label-picker]')!;
  expect(fields(picker)).toEqual({
    intent: 'assign-by-name',
    subjectId: subject.id,
    idempotencyKey: id(32),
    createKey: id(31),
    csrf_token: 'csrf-A',
  });
  await focusOnly([button(longLabel), button(multiwordLabel), button(m.library_collection_cancel())]);
  await click(m.library_collection_cancel());
  expect(labels).toHaveLength(0);
  expect(host.querySelector('[data-subject-label-picker]')).toBeNull();
  expect(window.document.activeElement).toBe(host.querySelector('[data-subject-label-picker-details] summary'));
  await openLabels();
  await resolveSearch();
  await click(longLabel);
  expect(labels[0]!.data).toEqual({ intent: 'assign', subjectId: subject.id, labelId: id(28), idempotencyKey: id(32) });
  await act(async () => labels[0]!.resolve({ ok: true, assignment: { id: id(29), revision: 1 } }));
  await openLabels();
  const name = 'New family reading '.repeat(11).slice(0, 200).trim();
  await labelName(name);
  await act(async () => prefixes.at(-1)!.resolve({ ...page('A', name), labels: [] }));
  const create = button(m.library_subject_label_create({ name }));
  expect(create.textContent).toBe(m.library_subject_label_create({ name }));
  await focusOnly([create, pickerSubmit()]);
  await click(create.textContent!);
  expect(labels[1]!.data).toEqual({
    intent: 'create-and-assign',
    subjectId: subject.id,
    name,
    createKey: id(31),
    idempotencyKey: expect.any(String),
  });
  expect(labels[1]!.data.idempotencyKey).not.toBe(id(32));
  await act(async () => labels[1]!.resolve({ ok: false, reason: 'capacity' }));
  expect(host.textContent).toContain(m.library_subject_label_capacity());
});

function pickerSubmit() {
  return host.querySelector<HTMLButtonElement>('[data-subject-label-picker] button[type="submit"]')!;
}

test('Uncertain Label removal retains its exact original intent and key across credential refresh, without render or focus retry', async () => {
  await ready();
  await submit('[data-subject-label-remove]');
  const original = labels[0]!.data;
  await act(async () => labels[0]!.reject(new Error('Unknown Label outcome')));
  expect(host.textContent).toContain(m.library_subject_label_unavailable());
  expect(host.textContent).toContain(longLabel);
  actualCredential = 'rotated';
  await act(async () => client.setQueryData(['session'], viewer('A', 'rotated')));
  await settle();
  expect(labels).toHaveLength(1);
  await focusOnly([button(m.library_selection_retry())]);
  await click(m.library_selection_retry());
  expect(labels[1]!.data).toEqual(original);
  expect(labels[1]!.csrf).toBe('rotated');
  await act(async () => labels[1]!.resolve({ ok: true, assignment: { id: id(20), revision: 9 }, restoreRevision: 12 }));
  expect(host.querySelector('[data-label-undo]')).not.toBeNull();
});

test('Viewer replacement and admission/address ABA retire held choices, remove and Undo without incidental dispatch or late invalidation', async () => {
  await ready({ ...baseline(), collectionsLoaded: true, collections: choices() });
  await openCollections();
  const oldChoice = button(longCollection + '0');
  await click(longCollection + '0');
  await click(m.library_subject_add_confirm());
  await submit('[data-subject-label-remove]');
  await openLabels();
  await observe('B');
  await settle();
  expect(host.querySelector('[data-subject-labels]')).toBeNull();
  const invalidation = spyOn(client, 'invalidateQueries');
  const routeInvalidation = spyOn(router, 'invalidate');
  await act(async () => {
    oldChoice.click();
    entries[0]!.resolve({ result: 'added' });
    labels[0]!.resolve({ ok: true, assignment: { id: id(20), revision: 9 }, restoreRevision: 12 });
    prefixes[0]!.resolve(page('A'));
  });
  expect(entries).toHaveLength(1);
  expect(labels).toHaveLength(1);
  expect(undos).toHaveLength(0);
  expect(window.document.body.textContent).not.toContain(longCollection);
  expect(invalidation).not.toHaveBeenCalled();
  expect(routeInvalidation).not.toHaveBeenCalled();
  invalidation.mockRestore();
  routeInvalidation.mockRestore();
  await observe('A');
  await ready();
  const retainedForm = retained(host.querySelector('[data-subject-label-remove]'));
  await act(async () => {
    const key = scopedKey();
    client.setQueryData(key, { subject: 'A', admitted: admitted.filter((gate) => gate !== 'library_label.unassign') });
    retainedForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    client.setQueryData(key, { subject: 'A', admitted });
  });
  await settle();
  expect(labels).toHaveLength(1);
  expect(host.querySelector('[data-subject-labels]')).toBeNull();
  await ready();
  await submit('[data-subject-label-remove]');
  await act(async () => labels[1]!.resolve({ ok: true, assignment: { id: id(20), revision: 9 }, restoreRevision: 12 }));
  const oldUndo = undos.at(-1)!;
  await act(async () => {
    await router.navigate({ href: `${canonical}/credits?cursor=next` });
    await router.navigate({ href: canonical });
    oldUndo();
  });
  expect(labels).toHaveLength(2);
  expect(host.querySelector('[data-label-undo]')).toBeNull();
});
