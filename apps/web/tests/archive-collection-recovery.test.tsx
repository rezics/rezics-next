import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import type {
  RecoveryCollection,
  RecoveryCollectionsPage,
  RecoveryOccurrence,
  RecoveryOccurrencesPage,
  RecoveryOutcomesPage,
  RecoveryPort,
  RecoveryReview,
  RecoveryStatus,
} from '../src/library/archive-collection-recovery/contract';
import type { RecoveryVisit } from '../src/library/archive-collection-recovery/visit';

const sourceId = '00000000-0000-4000-8000-000000000001';
const collectionId = '00000000-0000-4000-8000-000000000002';
const subjectId = '00000000-0000-4000-8000-000000000003';
const occurrenceOne = '00000000-0000-4000-8000-000000000004';
const occurrenceTwo = '00000000-0000-4000-8000-000000000005';
const targetId = '00000000-0000-4000-8000-000000000006';
const receivingCollectionId = '00000000-0000-4000-8000-000000000007';
const deadline = '2099-01-01T00:00:00.000Z';
const target: EntityPickerSubject = {
  id: targetId,
  title: 'Current canonical Subject',
  types: ['schema:Book'],
  typeLabel: 'Book',
  year: 2024,
  cover: null,
};

mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
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
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { ArchiveCollectionRecoveryPortContext } = await import('../src/library/archive-collection-recovery/port');
const { PrivateArchiveCollectionRecoveryPage } = await import('../src/library/archive-collection-recovery/page');
const previousLocale = getLocale();
await setLocale('en', { reload: false });

function status(
  state: RecoveryStatus['state'],
  overrides: Partial<RecoveryStatus> = {},
): RecoveryStatus {
  return {
    uploadId: sourceId,
    state,
    createdAt: null,
    expiresAt: deadline,
    manifest: null,
    coverage: [
      { section: 'collections', capture: 'present', treatment: 'requires-explicit-mapping', rows: 1, reason: 'private' },
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
const occurrenceCollection: NonNullable<RecoveryOccurrencesPage['collection']> = {
  ...collection,
  presentationDisposition: 'retained',
};

function collectionsPage(sourceRecordCount = 64): RecoveryCollectionsPage {
  return { ...status('preview', { sourceRecordCount }), next: null, collections: [collection] };
}

function occurrencesPage(rows: RecoveryOccurrence[] = [firstOccurrence, secondOccurrence]): RecoveryOccurrencesPage {
  return {
    ...status('preview', { selectedCollectionId: collectionId }),
    next: null,
    collection: occurrenceCollection,
    occurrences: rows,
  };
}

function reviewResult(): RecoveryReview {
  const mapping = {
    sourceSubjectId: subjectId,
    targetSubjectId: targetId,
    currentSubjectId: targetId,
    state: 'mapped' as const,
  };
  return {
    ...status('reviewed', { selectedCollectionId: collectionId, selectedOccurrences: 2 }),
    review: {
      reviewId: 'recovery-review-1',
      digest: 'a'.repeat(64),
      epoch: 1,
      completeOrder: true,
      completeMembership: true,
      selectedOccurrences: 2,
      mappings: [mapping],
    },
    mappings: [mapping],
    completeOrder: true,
    completeMembership: true,
    pin: { state: 'unsupported', reason: null, reviewedRevision: null },
  };
}

function outcomesPage(state: 'partial' | 'cancelled' = 'partial'): RecoveryOutcomesPage {
  return {
    ...status(state, { selectedCollectionId: collectionId, selectedOccurrences: 2, collectionId: receivingCollectionId }),
    next: null,
    collection: { id: receivingCollectionId, visibility: 'private' },
    outcomes: [
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
        sourceOccurrenceId: occurrenceTwo,
        sourceSubjectId: subjectId,
        targetSubjectId: targetId,
        nativeMemberId: null,
        note: 'Second archived note',
        notePresent: true,
        noteValid: true,
        sourceNoteState: 'value',
        orderKey: '1',
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

function fakePort(options: { uncertainApply?: boolean; staleReview?: boolean; sourceRecordCount?: number } = {}) {
  const calls: { upload: unknown[]; collections: unknown[]; occurrences: unknown[]; reviews: unknown[]; applies: unknown[]; cancels: unknown[] } = {
    upload: [], collections: [], occurrences: [], reviews: [], applies: [], cancels: [],
  };
  let cancelled = false;
  const port: RecoveryPort = {
    async upload(command) {
      calls.upload.push(structuredClone(command));
      return { kind: 'ok', value: status('preview', { sourceRecordCount: options.sourceRecordCount ?? 64 }) };
    },
    async status() { return { kind: 'ok', value: status('preview') }; },
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
      return { kind: 'ok', value: reviewResult() };
    },
    async apply(command) {
      calls.applies.push(structuredClone(command));
      if (options.uncertainApply && calls.applies.length === 1)
        return { kind: 'unknown', command: structuredClone(command) };
      return { kind: 'ok', value: status('partial', { selectedCollectionId: collectionId, selectedOccurrences: 2, collectionId: receivingCollectionId }) };
    },
    async outcomes() { return { kind: 'ok', value: outcomesPage(cancelled ? 'cancelled' : 'partial') }; },
    async cancel(command) {
      calls.cancels.push(structuredClone(command));
      cancelled = true;
      return { kind: 'ok', value: status('cancelled', { selectedCollectionId: collectionId, selectedOccurrences: 2, collectionId: receivingCollectionId }) };
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

async function uploadSmallFile(host: HTMLElement) {
  const input = host.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['{}'], 'library.json')] });
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  const form = input.closest('form')!;
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function chooseCurrentTarget(host: HTMLElement) {
  const input = [...host.querySelectorAll('input')].find((item) => item.getAttribute('aria-label') === m.library_copy_edition());
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, target.title);
  await act(async () => input!.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: target.title })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const option = [...window.document.querySelectorAll('[role=option]')].find((item) => item.textContent?.includes(target.title));
  expect(option).toBeTruthy();
  await click(option!);
}

test('mounted visit preserves duplicate occurrences, refreshes a stale review, confirms a private result and retries the exact uncertain command', async () => {
  const fake = fakePort({ uncertainApply: true, staleReview: true });
  const view = await mount(fake.port);
  try {
    await uploadSmallFile(view.host);
    await click(button(view.host, m.library_archive_recovery_choose_collection()));
    const rows = [...view.host.querySelectorAll('input[type=checkbox][aria-label]')];
    expect(rows).toHaveLength(2);
    expect(view.host.textContent).toContain('First archived note');
    expect(view.host.textContent).toContain('Second archived note');
    await click(rows[0]!);
    await click(rows[1]!);
    await click(button(view.host, m.library_archive_recovery_open_review()));
    await chooseCurrentTarget(view.host);
    await click(button(view.host, m.library_archive_recovery_review_action()));
    expect(view.host.querySelector('[data-recovery-state="conflict"]')).toBeTruthy();
    await click(button(view.host, m.library_archive_recovery_refresh()));
    expect(view.host.querySelector('[data-recovery-state="conflict"]')).toBeNull();
    await click(button(view.host, m.library_archive_recovery_open_review()));
    await click(button(view.host, m.library_archive_recovery_review_action()));
    const reviewed = fake.calls.reviews[0] as { body: { selectedOccurrenceIds: string[]; mappings: { sourceSubjectId: string; targetSubjectId: string | null }[] } };
    expect(reviewed.body.selectedOccurrenceIds).toEqual([occurrenceOne, occurrenceTwo]);
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
    expect(view.router.state.location.search).toEqual({});
    expect(view.router.state.location.hash).toBe('');
    expect(fake.calls.collections).toHaveLength(1);
    expect(fake.calls.occurrences).toHaveLength(1);
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
  latePort.upload = () => new Promise((resolve) => { resolveUpload = resolve; });
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
        occurrence(`00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`, `note-${index}`, String(index + 1)),
      );
      const fake = fakePort({ sourceRecordCount });
      fake.port.occurrences = async (_id, _collectionId, query) => {
        fake.calls.occurrences.push(structuredClone(query));
        return { kind: 'ok', value: occurrencesPage(rows) };
      };
      const journeyVisit = visit();
      const { createArchiveCollectionRecoveryJourney } = await import('../src/library/archive-collection-recovery/controller');
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
        expect(fake.calls.occurrences.map((query) => query.cursor ?? null)).toEqual([null, 'deep/native/cursor', 'terminal/native/cursor']);
        measures.push([cost.calls.collections, cost.calls.occurrences, cost.calls.review, cost.calls.apply, cost.calls.outcomes]);
      } finally {
        journey.retire();
      }
    }
  }
  expect(measures.every((measure) => measure.join() === measures[0]!.join())).toBe(true);
});

afterAll(async () => {
  await setLocale(previousLocale, { reload: false });
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.abort();
});
