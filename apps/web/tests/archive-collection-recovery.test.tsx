import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import {
  RECOVERY_UPLOAD_BYTES,
  type RecoveryCollection,
  type RecoveryCollectionsPage,
  type RecoveryOccurrence,
  type RecoveryOccurrencesPage,
  type RecoveryOutcomesPage,
  type RecoveryPort,
  type RecoveryReview,
  type RecoveryStatus,
} from '../src/library/archive-collection-recovery/contract';
import type { RecoveryVisit } from '../src/library/archive-collection-recovery/visit';
import {
  commitRecoveryRead,
  emptyRecoveryReadWindow,
  recoveryReadTarget,
  type RecoveryReadAdmission,
} from '../src/library/archive-collection-recovery/window';

const sourceId = '00000000-0000-4000-8000-000000000001';
const collectionId = '00000000-0000-4000-8000-000000000002';
const subjectId = '00000000-0000-4000-8000-000000000003';
const occurrenceOne = '00000000-0000-4000-8000-000000000004';
const occurrenceTwo = '00000000-0000-4000-8000-000000000005';
const occurrenceThree = '00000000-0000-4000-8000-000000000009';
const targetId = '00000000-0000-4000-8000-000000000006';
const receivingCollectionId = '00000000-0000-4000-8000-000000000007';
const deadline = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const target: EntityPickerSubject = {
  id: targetId,
  title: 'Current canonical Subject',
  types: ['schema:Book'],
  typeLabel: 'Book',
  year: 2024,
  cover: null,
};

mock.module('../src/kernel/exposure', () => ({ useOperationAdmission: () => 'available' }));
mock.module('../src/threads/content-subject-search', () => ({
  ContentSubjectSearchError: class ContentSubjectSearchError extends Error {},
  searchContentSubjects: async () => [target],
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/recover-collections' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  PointerEvent: window.PointerEvent,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  InputEvent: window.InputEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { ArchiveCollectionRecoveryPortContext } = await import('../src/library/archive-collection-recovery/port');
const { PrivateArchiveCollectionRecoveryPage } = await import('../src/library/archive-collection-recovery/page');
const previousLocale = getLocale();
await setLocale('en', { reload: false });

function status(state: RecoveryStatus['state'], overrides: Partial<RecoveryStatus> = {}): RecoveryStatus {
  return {
    uploadId: sourceId,
    state,
    createdAt: null,
    expiresAt: deadline,
    manifest: null,
    coverage: [
      {
        section: 'collections',
        capture: 'present',
        treatment: 'requires-explicit-mapping',
        rows: 1,
        reason: 'private',
      },
      { section: 'entries', capture: 'empty', treatment: 'retained-unsupported', rows: 0, reason: 'not captured' },
    ],
    sourceRecordCount: 64,
    selectedCollectionId: null,
    selectedOccurrences: 0,
    cancelRequested: false,
    collectionId: null,
    confirmation: null,
    pin: { state: 'unsupported', reason: null },
    sectionReasons: {},
    ...overrides,
  };
}

const collection: RecoveryCollection = {
  id: collectionId,
  title: 'Private reading collection',
  description: 'Curated source description',
  metadataValid: true,
  visibility: 'private',
  membershipKind: 'manual',
  builtinKind: null,
  presentationKind: 'collection',
  memberCount: 2,
  orderedCount: 2,
  eligible: true,
  membershipComplete: true,
  orderComplete: true,
  visibilityDisposition: 'private',
  unsupported: null,
};

function occurrence(id: string, note: string, orderKey: string): RecoveryOccurrence {
  return {
    sourceOccurrenceId: id,
    sourceSubjectId: subjectId,
    note,
    notePresent: true,
    noteValid: true,
    noteState: 'value',
    orderKey,
    orderPresent: true,
    orderState: 'supported',
  };
}

const firstOccurrence = occurrence(occurrenceOne, 'First archived note', '2');
const secondOccurrence = occurrence(occurrenceTwo, 'Second archived note', '1');
const thirdOccurrence = occurrence(occurrenceThree, 'Third archived note', '0');
const occurrenceCollection: NonNullable<RecoveryOccurrencesPage['collection']> = {
  ...collection,
  presentationDisposition: 'retained',
};

function collectionsPage(
  sourceRecordCount = 64,
  collections: RecoveryCollection[] = [collection],
  next: string | null = null,
): RecoveryCollectionsPage {
  return { ...status('preview', { sourceRecordCount }), next, collections };
}

function occurrencesPage(
  rows: RecoveryOccurrence[] = [firstOccurrence, secondOccurrence],
  next: string | null = null,
): RecoveryOccurrencesPage {
  return {
    ...status('preview', { selectedCollectionId: collectionId }),
    next,
    collection: occurrenceCollection,
    occurrences: rows,
  };
}

function reviewResult(selectedOccurrences = 2): RecoveryReview {
  const mapping = {
    sourceSubjectId: subjectId,
    targetSubjectId: targetId,
    currentSubjectId: targetId,
    state: 'mapped' as const,
  };
  return {
    ...status('reviewed', { selectedCollectionId: collectionId, selectedOccurrences }),
    review: {
      reviewId: 'recovery-review-1',
      digest: 'a'.repeat(64),
      epoch: 1,
      completeOrder: true,
      completeMembership: true,
      selectedOccurrences,
      mappings: [mapping],
    },
    mappings: [mapping],
    completeOrder: true,
    completeMembership: true,
    pin: { state: 'unsupported', reason: null, reviewedRevision: null },
  };
}

function outcomesPage(
  state: 'partial' | 'complete' | 'cancelled' = 'partial',
  next: string | null = null,
  empty = false,
): RecoveryOutcomesPage {
  return {
    ...status(state, {
      selectedCollectionId: collectionId,
      selectedOccurrences: 2,
      collectionId: receivingCollectionId,
    }),
    next,
    collection: { id: receivingCollectionId, visibility: 'private' },
    outcomes: empty
      ? []
      : [
          {
            sourceOccurrenceId: occurrenceOne,
            sourceSubjectId: subjectId,
            targetSubjectId: targetId,
            nativeMemberId: '00000000-0000-4000-8000-000000000008',
            note: 'First archived note',
            notePresent: true,
            noteValid: true,
            sourceNoteState: 'value',
            orderKey: '2',
            orderPresent: true,
            addState: 'applied',
            noteState: 'applied',
            orderState: 'applied',
            outcomeReason: null,
            outcome: 'applied',
          },
          {
            sourceOccurrenceId: occurrenceThree,
            sourceSubjectId: subjectId,
            targetSubjectId: targetId,
            nativeMemberId: null,
            note: 'Third archived note',
            notePresent: true,
            noteValid: true,
            sourceNoteState: 'value',
            orderKey: '0',
            orderPresent: true,
            addState: 'unresolved',
            noteState: 'unsupported',
            orderState: 'unsupported',
            outcomeReason: 'subject_unresolved',
            outcome: 'partial',
          },
        ],
  };
}

function visit(subject = 'viewer-a', csrfToken = 'epoch-a'): RecoveryVisit {
  const controller = new AbortController();
  return {
    subject,
    csrfToken,
    controller,
    current: (signal) => !controller.signal.aborted && signal?.aborted !== true,
    retire: () => controller.abort(),
  };
}

function fakePort(
  options: {
    uncertainApply?: boolean;
    uncertainUpload?: boolean;
    staleReview?: boolean;
    sourceRecordCount?: number;
  } = {},
) {
  const calls: {
    upload: unknown[];
    collections: unknown[];
    occurrences: unknown[];
    outcomes: unknown[];
    reviews: unknown[];
    applies: unknown[];
    cancels: unknown[];
    readbacks: unknown[];
  } = {
    upload: [],
    collections: [],
    occurrences: [],
    outcomes: [],
    reviews: [],
    applies: [],
    cancels: [],
    readbacks: [],
  };
  let cancelled = false;
  const port: RecoveryPort = {
    async upload(command) {
      calls.upload.push(structuredClone(command));
      if (options.uncertainUpload && calls.upload.length === 1)
        return { kind: 'unknown', command: structuredClone(command) };
      return { kind: 'ok', value: status('preview', { sourceRecordCount: options.sourceRecordCount ?? 64 }) };
    },
    async status() {
      return { kind: 'ok', value: status('preview') };
    },
    async collections(_id, query) {
      calls.collections.push(structuredClone(query));
      return { kind: 'ok', value: collectionsPage(options.sourceRecordCount ?? 64) };
    },
    async occurrences(_id, _collectionId, query) {
      calls.occurrences.push(structuredClone(query));
      return { kind: 'ok', value: occurrencesPage() };
    },
    async review(command) {
      calls.reviews.push(structuredClone(command));
      if (options.staleReview && calls.reviews.length === 1) return { kind: 'conflict' };
      return { kind: 'ok', value: reviewResult(command.body.selectedOccurrenceIds.length) };
    },
    async apply(command) {
      calls.applies.push(structuredClone(command));
      if (options.uncertainApply && calls.applies.length === 1)
        return { kind: 'unknown', command: structuredClone(command) };
      return {
        kind: 'ok',
        value: status('partial', {
          selectedCollectionId: collectionId,
          selectedOccurrences: 2,
          collectionId: receivingCollectionId,
        }),
      };
    },
    async outcomes(_id, query) {
      calls.outcomes.push(structuredClone(query));
      return { kind: 'ok', value: outcomesPage(cancelled ? 'cancelled' : 'partial') };
    },
    async cancel(command) {
      calls.cancels.push(structuredClone(command));
      cancelled = true;
      return {
        kind: 'ok',
        value: status('cancelled', {
          selectedCollectionId: collectionId,
          selectedOccurrences: 2,
          collectionId: receivingCollectionId,
        }),
      };
    },
    async receivingCollection(id, cursor) {
      calls.readbacks.push({ id, cursor: cursor ?? null });
      return {
        kind: 'ok',
        value: {
          id: receivingCollectionId,
          title: 'Restored private Collection',
          visibility: 'private',
          memberCount: 2,
          next: null,
          members: [
            {
              id: '00000000-0000-4000-8000-000000000008',
              subjectId: targetId,
              note: 'First archived note',
              addedAt: '2024-01-01T00:00:00.000Z',
            },
            {
              id: '00000000-0000-4000-8000-000000000010',
              subjectId: targetId,
              note: 'Repeated occurrence',
              addedAt: '2024-01-01T00:00:01.000Z',
            },
          ],
        },
      };
    },
  };
  return { port, calls };
}

async function mount(port: RecoveryPort, initialVisit = visit()) {
  let currentVisit = initialVisit;
  let forceRender = () => undefined;
  function TestRoot() {
    const [, setRevision] = useState(0);
    forceRender = () => setRevision((value) => value + 1);
    return createElement(
      ArchiveCollectionRecoveryPortContext.Provider,
      { value: port },
      createElement(PrivateArchiveCollectionRecoveryPage, { visit: currentVisit }),
    );
  }
  const rootRoute = createRootRoute({ component: TestRoot });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(RouterProvider, { router })));
  return {
    host,
    router,
    replaceVisit: async (next: RecoveryVisit) => {
      currentVisit = next;
      await act(async () => forceRender());
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const result = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  expect(result).toBeTruthy();
  return result!;
}

async function click(element: Element) {
  await act(async () => {
    if (element instanceof window.HTMLInputElement) element.click();
    else element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function keyboardClick(element: HTMLButtonElement) {
  await act(async () => {
    element.focus();
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function selectFile(host: HTMLElement, file: File) {
  const input = host.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  return input;
}

async function submitFile(host: HTMLElement) {
  const input = host.querySelector('input[type=file]') as HTMLInputElement;
  const form = input.closest('form')!;
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function uploadSmallFile(host: HTMLElement, file = new window.File(['{}'], 'library.json')) {
  await selectFile(host, file);
  await submitFile(host);
}

function delayedFile(name: string) {
  let finish!: (bytes: ArrayBuffer) => void;
  let reads = 0;
  const file = new window.File(['{}'], name);
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => {
      reads++;
      return new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      });
    },
  });
  return {
    file,
    get reads() {
      return reads;
    },
    finish: () => finish(new Uint8Array([123, 125]).buffer as ArrayBuffer),
  };
}

test('delayed preparation admits one selected file and suppresses duplicate submit work', async () => {
  const fake = fakePort();
  const view = await mount(fake.port);
  const archive = delayedFile('chosen.json');
  try {
    const input = await selectFile(view.host, archive.file);
    const form = input.closest('form')!;
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(archive.reads).toBe(1);
    expect(view.host.querySelector('[role=status]')?.textContent).toContain(m.library_archive_recovery_preparing());
    expect(input.disabled).toBe(true);
    expect(button(view.host, m.library_archive_recovery_preparing()).disabled).toBe(true);
    await act(async () => {
      archive.finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fake.calls.upload).toHaveLength(1);
    expect(fake.calls.upload[0]).toMatchObject({ body: { archiveBase64: 'e30=' } });
  } finally {
    await view.close();
  }
});

test('replacement, read failure, and retired visits cannot hand off a stale archive', async () => {
  const fake = fakePort();
  const view = await mount(fake.port);
  try {
    const old = delayedFile('old.json');
    const input = await selectFile(view.host, old.file);
    await submitFile(view.host);
    const replacement = new window.File(['next'], 'new.json');
    Object.defineProperty(replacement, 'arrayBuffer', {
      value: async () => new Uint8Array([110, 101, 120, 116]).buffer as ArrayBuffer,
    });
    await selectFile(view.host, replacement);
    old.finish();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(fake.calls.upload).toHaveLength(0);
    expect((input.files?.[0] as File).name).toBe('new.json');
    await submitFile(view.host);
    expect(fake.calls.upload).toHaveLength(1);
    expect(fake.calls.upload[0]).toMatchObject({ body: { archiveBase64: 'bmV4dA==' } });

    const retryView = await mount(fake.port);
    try {
      const reads = { count: 0 };
      const retryFile = new window.File(['{}'], 'retry.json');
      Object.defineProperty(retryFile, 'arrayBuffer', {
        value: async () => {
          if (++reads.count === 1) throw new Error('read failed');
          return new Uint8Array([123, 125]).buffer as ArrayBuffer;
        },
      });
      const retryInput = await selectFile(retryView.host, retryFile);
      await submitFile(retryView.host);
      expect(retryView.host.querySelector('[role=alert]')?.textContent).toContain(
        m.library_archive_recovery_upload_read_failed(),
      );
      expect((retryInput.files?.[0] as File).name).toBe('retry.json');
      await submitFile(retryView.host);
      expect(reads.count).toBe(2);
      expect(fake.calls.upload).toHaveLength(2);
    } finally {
      await retryView.close();
    }

    const retiredRead = delayedFile('retired.json');
    const retiredView = await mount(fake.port, visit('viewer-a', 'epoch-a'));
    await selectFile(retiredView.host, retiredRead.file);
    await submitFile(retiredView.host);
    await retiredView.replaceVisit(visit('viewer-b', 'epoch-b'));
    retiredRead.finish();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(fake.calls.upload).toHaveLength(2);
    expect(retiredView.host.textContent).not.toContain(m.library_archive_recovery_preparing());
    await retiredView.close();

    const routeRead = delayedFile('route.json');
    const routeView = await mount(fake.port);
    await selectFile(routeView.host, routeRead.file);
    await submitFile(routeView.host);
    await routeView.close();
    routeRead.finish();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(fake.calls.upload).toHaveLength(2);
  } finally {
    await view.close();
  }
});

test('empty and over-limit files remain local without a read or native upload', async () => {
  const fake = fakePort();
  const view = await mount(fake.port);
  let reads = 0;
  try {
    const empty = new window.File([], 'empty.json');
    Object.defineProperty(empty, 'arrayBuffer', { value: () => (reads++, Promise.resolve(new ArrayBuffer(0))) });
    const input = await selectFile(view.host, empty);
    await submitFile(view.host);
    expect(view.host.querySelector('[role=alert]')?.textContent).toContain(m.library_archive_recovery_upload_empty());

    const oversized = new window.File(['x'], 'large.json');
    Object.defineProperty(oversized, 'size', { value: RECOVERY_UPLOAD_BYTES + 1 });
    Object.defineProperty(oversized, 'arrayBuffer', { value: () => (reads++, Promise.resolve(new ArrayBuffer(1))) });
    await selectFile(view.host, oversized);
    await submitFile(view.host);
    expect(view.host.querySelector('[role=alert]')?.textContent).toContain(
      m.library_archive_recovery_upload_too_large(),
    );
    expect(input.disabled).toBe(false);
    expect(reads).toBe(0);
    expect(fake.calls.upload).toHaveLength(0);
  } finally {
    await view.close();
  }
});

async function chooseCurrentTarget(host: HTMLElement) {
  const input = [...host.querySelectorAll('input')].find(
    (item) => item.getAttribute('aria-label') === m.library_copy_edition(),
  );
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    input!.focus();
    setter?.call(input, target.title);
    input!.dispatchEvent(
      new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: target.title }),
    );
  });
  await act(async () => Bun.sleep(270));
  const option = [...window.document.querySelectorAll('[role=option]')].find((item) =>
    item.textContent?.includes(target.title),
  );
  expect(option).toBeTruthy();
  await click(option!);
}

test('mounted recovery navigates independent native windows, revises selection, retries only the failed read, and applies the exact review', async () => {
  const fake = fakePort({ uncertainApply: true, staleReview: true });
  fake.port.collections = async (_id, query) => {
    fake.calls.collections.push(structuredClone(query));
    const pages = new Map<string | null, RecoveryCollectionsPage>([
      [null, collectionsPage(64, [], 'collections-2')],
      ['collections-2', collectionsPage(64, [collection], 'collections-3')],
      ['collections-3', collectionsPage(64, [])],
    ]);
    return { kind: 'ok', value: pages.get(query.cursor ?? null)! };
  };
  let failedOccurrenceRead = false;
  fake.port.occurrences = async (_id, _collectionId, query) => {
    fake.calls.occurrences.push(structuredClone(query));
    if (query.cursor === 'occurrences-2' && !failedOccurrenceRead) {
      failedOccurrenceRead = true;
      return { kind: 'unavailable' };
    }
    const pages = new Map<string | null, RecoveryOccurrencesPage>([
      [null, occurrencesPage([firstOccurrence], 'occurrences-2')],
      ['occurrences-2', occurrencesPage([secondOccurrence], 'occurrences-3')],
      ['occurrences-3', occurrencesPage([thirdOccurrence])],
    ]);
    return { kind: 'ok', value: pages.get(query.cursor ?? null)! };
  };
  let resultState: 'partial' | 'complete' = 'partial';
  fake.port.outcomes = async (_id, query) => {
    fake.calls.outcomes.push(structuredClone(query));
    if (query.cursor === 'results-2' && resultState === 'partial') {
      resultState = 'complete';
      return { kind: 'ok', value: outcomesPage('complete') };
    }
    return {
      kind: 'ok',
      value: query.cursor
        ? outcomesPage(resultState, null, resultState === 'complete')
        : outcomesPage(resultState, 'results-2'),
    };
  };
  const view = await mount(fake.port);
  try {
    await uploadSmallFile(view.host);
    await keyboardClick(button(view.host, m.library_archive_recovery_next_page()));
    expect(view.host.textContent).toContain('Private reading collection');
    expect(window.document.activeElement?.id).toBe('recovery-collections-title');
    await click(button(view.host, m.library_archive_recovery_next_page()));
    expect(view.host.textContent).toContain(m.library_archive_recovery_no_collection_window());
    await click(button(view.host, m.library_window_previous()));
    expect(view.host.textContent).toContain('Private reading collection');
    await click(button(view.host, m.library_archive_recovery_first_page()));
    expect(view.host.textContent).toContain(m.library_archive_recovery_no_collection_window());
    await click(button(view.host, m.library_archive_recovery_next_page()));
    await click(button(view.host, m.library_archive_recovery_choose_collection()));
    let rows = [...view.host.querySelectorAll('input[type=checkbox][aria-label]')];
    expect(rows).toHaveLength(1);
    expect(view.host.textContent).toContain('First archived note');
    await click(rows[0]!);
    await click(button(view.host, m.library_archive_recovery_next_page()));
    expect(view.host.textContent).toContain(m.library_archive_recovery_unavailable());
    expect(fake.calls.reviews).toHaveLength(0);
    expect(fake.calls.applies).toHaveLength(0);
    await click(button(view.host, m.library_archive_recovery_retry_page()));
    rows = [...view.host.querySelectorAll('input[type=checkbox][aria-label]')];
    expect(rows).toHaveLength(1);
    expect(view.host.textContent).toContain('Second archived note');
    await click(rows[0]!);
    await click(button(view.host, m.library_archive_recovery_next_page()));
    expect(view.host.textContent).toContain('Third archived note');
    rows = [...view.host.querySelectorAll('input[type=checkbox][aria-label]')];
    await click(rows[0]!);
    await click(button(view.host, m.library_window_previous()));
    rows = [...view.host.querySelectorAll('input[type=checkbox][aria-label]')];
    expect(rows[0]?.checked).toBe(true);
    await click(rows[0]!);
    await click(button(view.host, m.library_archive_recovery_first_page()));
    rows = [...view.host.querySelectorAll('input[type=checkbox][aria-label]')];
    expect(rows[0]?.checked).toBe(true);
    expect(view.host.textContent).toContain(m.library_archive_recovery_selection_count({ count: 2, maximum: 1000 }));
    await click(button(view.host, m.library_archive_recovery_open_review()));
    await click(button(view.host, m.library_archive_recovery_edit_selection()));
    expect(view.host.textContent).toContain(m.library_archive_recovery_selection_count({ count: 2, maximum: 1000 }));
    await click(button(view.host, m.library_archive_recovery_open_review()));
    await chooseCurrentTarget(view.host);
    await click(button(view.host, m.library_archive_recovery_review_action()));
    expect(view.host.querySelector('[data-recovery-state="conflict"]')).toBeTruthy();
    await click(button(view.host, m.library_archive_recovery_refresh()));
    expect(view.host.querySelector('[data-recovery-state="conflict"]')).toBeNull();
    await click(button(view.host, m.library_archive_recovery_open_review()));
    await click(button(view.host, m.library_archive_recovery_review_action()));
    const reviewed = fake.calls.reviews[0] as {
      body: {
        selectedOccurrenceIds: string[];
        mappings: { sourceSubjectId: string; targetSubjectId: string | null }[];
      };
    };
    expect(reviewed.body.selectedOccurrenceIds).toEqual([occurrenceOne, occurrenceThree]);
    expect(reviewed.body.mappings).toEqual([{ sourceSubjectId: subjectId, targetSubjectId: targetId }]);
    expect(view.host.textContent).toContain(m.library_archive_recovery_new_private_destination());
    expect(view.host.textContent).toContain(m.library_archive_recovery_mapping_current({ id: targetId }));
    const confirmation = view.host.querySelector('input[type=checkbox]')!;
    await click(confirmation);
    await click(button(view.host, m.library_archive_recovery_apply_action()));
    expect(view.host.textContent).toContain(m.library_archive_recovery_uncertain());
    const firstCommand = fake.calls.applies[0];
    await click(button(view.host, m.library_archive_recovery_retry_original()));
    expect(fake.calls.applies).toHaveLength(2);
    expect(fake.calls.applies[1]).toEqual(firstCommand);
    expect(view.host.querySelector('[data-recovery-state="partial"]')).toBeTruthy();
    expect(view.host.textContent).toContain(m.library_archive_recovery_effect_applied());
    expect(view.host.textContent).toContain(m.library_archive_recovery_effect_unresolved());
    expect(view.host.querySelector('a[href*="/collections/"]')?.getAttribute('href')).toContain(receivingCollectionId);
    await click(button(view.host, m.library_archive_recovery_next_results()));
    expect(view.host.querySelector('[data-recovery-state="complete"]')).toBeTruthy();
    await click(button(view.host, m.library_archive_recovery_read_outcomes()));
    await click(button(view.host, m.library_archive_recovery_next_results()));
    expect(view.host.textContent).toContain(m.library_archive_recovery_no_outcomes());
    await click(button(view.host, m.library_window_previous()));
    await click(button(view.host, m.library_archive_recovery_first_page()));
    await click(button(view.host, m.library_archive_recovery_next_results()));
    expect(view.router.state.location.search).toEqual({});
    expect(view.router.state.location.hash).toBe('');
    expect(fake.calls.collections.map((query) => (query as { cursor?: string }).cursor ?? null)).toEqual([
      null,
      'collections-2',
      'collections-3',
      'collections-2',
      null,
      'collections-2',
    ]);
    expect(fake.calls.occurrences.map((query) => (query as { cursor?: string }).cursor ?? null)).toEqual([
      null,
      'occurrences-2',
      'occurrences-2',
      'occurrences-3',
      'occurrences-2',
      null,
    ]);
    expect(fake.calls.outcomes.map((query) => (query as { cursor?: string }).cursor ?? null)).toEqual([
      null,
      'results-2',
      null,
      'results-2',
      null,
      null,
      'results-2',
    ]);
  } finally {
    await view.close();
  }
});

test('equal replacement and A/B/A visits retire prior reader coordinates', async () => {
  const fake = fakePort();
  const view = await mount(fake.port, visit('viewer-a', 'epoch-a'));
  try {
    await uploadSmallFile(view.host);
    expect(view.host.textContent).toContain(collection.title);
    await view.replaceVisit(visit('viewer-a', 'epoch-a'));
    expect(view.host.querySelector('input[type=file]')).toBeTruthy();
    expect(view.host.textContent).not.toContain(collection.title);

    await uploadSmallFile(view.host);
    await click(button(view.host, m.library_archive_recovery_choose_collection()));
    expect(view.host.textContent).toContain('First archived note');
    await view.replaceVisit(visit('viewer-b', 'epoch-b'));
    expect(view.host.querySelector('input[type=file]')).toBeTruthy();
    await view.replaceVisit(visit('viewer-a', 'epoch-a'));
    expect(view.host.querySelector('input[type=file]')).toBeTruthy();
    expect(view.host.textContent).not.toContain('First archived note');
  } finally {
    await view.close();
  }
});

test('mounted uncertain archive upload retries its exact command without reading the file again', async () => {
  const fake = fakePort({ uncertainUpload: true });
  const view = await mount(fake.port);
  const archive = new window.File(['{}'], 'library.json');
  let reads = 0;
  Object.defineProperty(archive, 'arrayBuffer', {
    value: async () => {
      reads++;
      return new Uint8Array([123, 125]).buffer as ArrayBuffer;
    },
  });
  try {
    await uploadSmallFile(view.host, archive);
    const originalUpload = fake.calls.upload[0];
    expect(view.host.textContent).toContain(m.library_archive_recovery_uncertain());
    await click(button(view.host, m.library_archive_recovery_retry_original()));
    expect(fake.calls.upload).toHaveLength(2);
    expect(fake.calls.upload[1]).toEqual(originalUpload);
    expect(reads).toBe(1);
  } finally {
    await view.close();
  }
});

test('mounted cancellation is explicit, preserves accepted effects, and a replaced viewer ignores a late private response', async () => {
  const fake = fakePort();
  const view = await mount(fake.port);
  try {
    await uploadSmallFile(view.host);
    await click(button(view.host, m.library_archive_recovery_cancel()));
    await click(button(window.document.body as unknown as HTMLElement, m.library_archive_recovery_confirm_cancel()));
    expect(fake.calls.cancels).toHaveLength(1);
    expect(view.host.querySelector('[data-recovery-state="cancelled"]')).toBeTruthy();
    expect(view.host.querySelector('a[href*="/collections/"]')?.getAttribute('href')).toContain(receivingCollectionId);
  } finally {
    await view.close();
  }

  let resolveUpload!: (result: Awaited<ReturnType<RecoveryPort['upload']>>) => void;
  const latePort = fakePort().port;
  latePort.upload = () =>
    new Promise((resolve) => {
      resolveUpload = resolve;
    });
  const replacement = await mount(latePort, visit('viewer-a', 'epoch-a'));
  try {
    await uploadSmallFile(replacement.host);
    await replacement.replaceVisit(visit('viewer-b', 'epoch-b'));
    resolveUpload({ kind: 'ok', value: status('preview') });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(replacement.host.textContent).not.toContain(collection.title);
    expect(replacement.host.querySelector('input[type=file]')).toBeTruthy();
  } finally {
    await replacement.close();
  }
});

test('one native page and one bounded apply keep request counts constant as unrelated archive size and page scale grow', async () => {
  const measures: number[][] = [];
  for (const sourceRecordCount of [64, 512, 4096]) {
    for (const rowCount of [1, 25, 50]) {
      const rows = Array.from({ length: rowCount }, (_, index) =>
        occurrence(
          `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
          `note-${index}`,
          String(index + 1),
        ),
      );
      const fake = fakePort({ sourceRecordCount });
      fake.port.occurrences = async (_id, _collectionId, query) => {
        fake.calls.occurrences.push(structuredClone(query));
        return { kind: 'ok', value: occurrencesPage(rows) };
      };
      const journeyVisit = visit();
      const { createArchiveCollectionRecoveryJourney } =
        await import('../src/library/archive-collection-recovery/controller');
      const journey = createArchiveCollectionRecoveryJourney({ port: fake.port, visit: journeyVisit });
      try {
        await journey.upload('e30=');
        await journey.chooseCollection(collection);
        await journey.loadOccurrences('deep/native/cursor');
        await journey.loadOccurrences('terminal/native/cursor');
        journey.setSelection(new Map(rows.map((row) => [row.sourceOccurrenceId, row])));
        journey.prepareReview();
        await journey.reviewSelection();
        await journey.apply();
        const cost = journey.snapshot().cost;
        expect(cost.maxPageRows).toBeLessThanOrEqual(50);
        expect(cost.calls.collections).toBe(1);
        expect(cost.calls.occurrences).toBe(3);
        expect(cost.calls.review).toBe(1);
        expect(cost.calls.apply).toBe(1);
        expect(fake.calls.occurrences.every((query) => query.limit === 50)).toBe(true);
        expect(fake.calls.occurrences.map((query) => query.cursor ?? null)).toEqual([
          null,
          'deep/native/cursor',
          'terminal/native/cursor',
        ]);
        measures.push([
          cost.calls.collections,
          cost.calls.occurrences,
          cost.calls.review,
          cost.calls.apply,
          cost.calls.outcomes,
        ]);
      } finally {
        journey.retire();
      }
    }
  }
  expect(measures.every((measure) => measure.join() === measures[0]!.join())).toBe(true);
});

test('cancel then restart reuses the original archive and native Collection readback shows restored order', async () => {
  const fake = fakePort();
  const { createArchiveCollectionRecoveryJourney } =
    await import('../src/library/archive-collection-recovery/controller');
  const journey = createArchiveCollectionRecoveryJourney({ port: fake.port, visit: visit() });
  try {
    await journey.upload('e30=');
    await journey.chooseCollection(collection);
    const rows = occurrencesPage().occurrences;
    journey.setSelection(new Map(rows.map((row) => [row.sourceOccurrenceId, row])));
    journey.setTarget(subjectId, target);
    journey.prepareReview();
    await journey.reviewSelection();
    await journey.apply();
    await journey.readReceivingCollection();
    const restored = journey.snapshot().receiving;
    expect(restored?.id).toBe(receivingCollectionId);
    expect(restored?.members.map((member) => member.note)).toEqual(['First archived note', 'Repeated occurrence']);
    expect(fake.calls.readbacks).toEqual([{ id: receivingCollectionId, cursor: null }]);
    await journey.cancel();
    journey.restart();
    expect(journey.snapshot()).toMatchObject({ stage: 'upload', hasOriginalArchive: true, uploadId: null });
    await journey.adoptOriginalArchive();
    expect(fake.calls.upload).toHaveLength(2);
    expect(fake.calls.upload[1]).toMatchObject({ body: { archiveBase64: 'e30=' } });
    expect((fake.calls.upload[1] as { key: string }).key).not.toBe((fake.calls.upload[0] as { key: string }).key);
    expect(journey.snapshot().stage).toBe('collections');
  } finally {
    journey.retire();
  }
});

test('another account is refused at the restored Collection reader', async () => {
  const fake = fakePort();
  fake.port.receivingCollection = async () => ({ kind: 'denied' });
  const { createArchiveCollectionRecoveryJourney } =
    await import('../src/library/archive-collection-recovery/controller');
  const journey = createArchiveCollectionRecoveryJourney({
    port: fake.port,
    visit: visit('other-member', 'epoch-other'),
  });
  try {
    await journey.upload('e30=');
    await journey.chooseCollection(collection);
    const rows = occurrencesPage().occurrences;
    journey.setSelection(new Map(rows.map((row) => [row.sourceOccurrenceId, row])));
    journey.setTarget(subjectId, target);
    journey.prepareReview();
    await journey.reviewSelection();
    await journey.apply();
    await journey.readReceivingCollection();
    expect(journey.snapshot().stage).toBe('denied');
    expect(journey.snapshot().notice).toEqual({ kind: 'denied' });
    expect(journey.snapshot().receiving).toBeNull();
  } finally {
    journey.retire();
  }
});

test('a cursor window retains eight predecessors and abandons a forward branch after returning', () => {
  const admission: RecoveryReadAdmission = {
    uploadId: sourceId,
    collectionId: null,
    phase: 'selection',
    statusState: null,
    sourceStage: 'collections',
  };
  let window = emptyRecoveryReadWindow();
  for (let index = 1; index <= 12; index++) {
    const target = recoveryReadTarget(window, 'next', admission, `cursor-${index}`)!;
    window = { ...window, staged: target };
    window = commitRecoveryRead(window, target);
  }
  expect(window.current).toBe('cursor-12');
  expect(window.previous).toHaveLength(8);
  expect(window.previous[0]).toBe('cursor-4');

  const previous = recoveryReadTarget(window, 'previous', admission)!;
  expect(previous.cursor).toBe('cursor-11');
  window = commitRecoveryRead({ ...window, staged: previous }, previous);
  const branch = recoveryReadTarget(window, 'next', admission, 'new-branch-12')!;
  window = commitRecoveryRead({ ...window, staged: branch }, branch);
  expect(window.current).toBe('new-branch-12');
  expect(window.previous.at(-1)).toBe('cursor-11');
  expect(window.previous).not.toContain('cursor-12');
  const first = recoveryReadTarget(window, 'first', admission)!;
  expect(first.cursor).toBeNull();
  window = commitRecoveryRead(window, first);
  expect(window.previous).toEqual([]);
});

afterAll(async () => {
  await setLocale(previousLocale, { reload: false });
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.abort();
});
