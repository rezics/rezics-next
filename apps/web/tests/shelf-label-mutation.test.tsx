import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, createElement } from 'react';
import type { PersonalLibraryEntry } from '../src/library/entries-read';
import type { ShelfOrigin } from '../src/library/personal-shelf-origin';
import type { SubjectLabelMutationInput, SubjectLabelMutationResult } from '../src/library/subject-labels.ts';

test('selected removal keeps later selection separate, preserves personal facts and recovers with exact CAS and key', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const context = createContext<ShelfOrigin | null>(null);
  mock.module('../src/library/personal-shelf-origin', () => ({ PersonalShelfOrigin: context }));
  mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
  mock.module('../src/session/query', () => ({ useSession: () => ({ state: 'signed-in', subject: 'owner' }) }));
  mock.module('../src/threads/composer', () => ({ csrfHeaders: () => new Headers() }));
  mock.module('@rezics/ui/undo-toast', () => ({ undoToast() {} }));
  mock.module('../src/library/entries-actions', () => ({
    deletePersonalLibraryEntry() {
      throw new Error('must not delete an entry');
    },
    restorePersonalLibraryEntryAction() {},
    savePersonalLibraryEntry() {
      throw new Error('must not change state');
    },
  }));
  const reads: string[] = [];
  let assignmentRevision = 4;
  let readViewer = 'owner';
  let readCsrfToken: string | null = 'csrf';
  mock.module('../src/library/labels-actions', () => ({
    readShelfLabelAssignment: async ({ data }: { data: { subjectId: string; labelId: string } }) => {
      reads.push(data.subjectId);
      return {
        state: 'loaded',
        provenance: { viewer: readViewer, csrfToken: readCsrfToken, ...data },
        assignment:
          data.subjectId === 'b' ? null : { id: `assignment-${data.subjectId}`, revision: assignmentRevision },
      };
    },
  }));
  const calls: SubjectLabelMutationInput[] = [];
  let answer: SubjectLabelMutationResult = { ok: true, assignment: { id: 'assignment-a', revision: 4 } };
  let release: (() => void) | undefined;
  let held = true;
  mock.module('../src/library/subject-slot-actions', () => ({
    mutateSubjectLabelAction: async ({ data }: { data: SubjectLabelMutationInput }) => {
      calls.push(structuredClone(data));
      if (held)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return answer;
    },
  }));
  const { useShelfRows, shelfMutationLease } = await import('../src/library/shelf-rows');
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  const root = createRoot(host as unknown as HTMLElement);
  const rows: PersonalLibraryEntry[] = ['a', 'b', 'c'].map((subjectId) => ({
    subjectId,
    revision: 2,
    incarnationId: `life-${subjectId}`,
    state: 'historic-state',
    changeKey: `state-${subjectId}`,
    removeKey: `remove-${subjectId}`,
    createdAt: '',
    updatedAt: '',
    subject: {
      id: subjectId,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: subjectId, language: 'en' },
      cover: null,
    },
  }));
  const before = structuredClone(rows);
  let initial = rows;
  const origin: ShelfOrigin = {
    current: () => true,
    viewer: () => 'owner',
    capture: () => () => true,
    version: () => '0',
    watch: () => () => {},
    headers: () => new Headers(readCsrfToken ? { 'x-csrf-token': readCsrfToken } : {}),
  };
  const lease = shelfMutationLease();
  let controls!: ReturnType<typeof useShelfRows>;
  function Shelf() {
    controls = useShelfRows(initial, 'en', lease);
    return null;
  }
  const label = { id: 'label', name: 'Revisit', revision: 1 };
  try {
    await act(async () => root.render(createElement(context.Provider, { value: origin }, createElement(Shelf))));
    await act(async () => {
      controls.select('a', true);
      controls.select('b', true);
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = controls.assignSelectedLabel(label, 'unassign');
    });
    expect(calls).toHaveLength(1);
    expect(controls.labelOutcomes.map((result) => result.status)).toEqual(['unknown', 'not-attempted']);
    expect(controls.selectionPending).toBe(false);
    await act(async () => {
      controls.clearSelection();
      controls.select('c', true);
      await controls.assignSelectedLabel(label);
    });
    expect(calls).toHaveLength(1);
    expect(controls.selected).toEqual(['c']);
    held = false;
    await act(async () => {
      release!();
      await pending;
    });
    expect(controls.labelOutcomes.map((result) => [result.subjectId, result.status])).toEqual([
      ['a', 'removed'],
      ['b', 'unchanged'],
    ]);
    expect(controls.selected).toEqual(['c']);
    expect(controls.rows.map((row) => row.entry)).toEqual(before);
    answer = { ok: false, reason: 'unavailable' };
    await act(async () => {
      await controls.assignSelectedLabel(label, 'unassign');
    });
    const uncertain = calls.at(-1)!;
    expect(uncertain).toMatchObject({ intent: 'unassign', subjectId: 'c', assignmentId: 'assignment-c', revision: 4 });
    initial = rows.map((row) => (row.subjectId === 'c' ? { ...row, revision: 3 } : row));
    await act(async () => root.render(createElement(context.Provider, { value: origin }, createElement(Shelf))));
    assignmentRevision = 9;
    answer = { ok: true, assignment: { id: 'assignment-c', revision: 4 } };
    await act(async () => {
      await controls.retryLabel('c');
    });
    expect(calls.at(-1)).toEqual(uncertain);
    expect(reads).toEqual(['a', 'b', 'c']);
    expect(controls.labelOutcomes[0]!.status).toBe('removed');
    answer = { ok: false, reason: 'conflict' };
    await act(async () => {
      await controls.assignSelectedLabel(label, 'unassign');
    });
    expect(controls.labelOutcomes[0]!.status).toBe('conflicted');
    expect(controls.rows.some((row) => row.unknownLabelIntent)).toBe(false);
    answer = { ok: true, assignment: { id: 'assignment-c', revision: 9 } };
    await act(async () => {
      await controls.assignSelectedLabel(label, 'unassign');
    });
    expect(calls.at(-1)).toMatchObject({ revision: 9 });
    expect(calls.at(-1)!.idempotencyKey).not.toBe(uncertain.idempotencyKey);
    expect(controls.rows.map((row) => row.entry)).toEqual(initial);
    readViewer = 'other';
    const sent = calls.length;
    await act(async () => {
      await controls.assignSelectedLabel(label, 'unassign');
    });
    expect(calls).toHaveLength(sent);
    expect(controls.labelOutcomes[0]!.status).toBe('failed');
    expect(lease.current).toBe(false);

    readViewer = 'owner';
    readCsrfToken = null;
    await act(async () => {
      controls.clearSelection();
      controls.select('a', true);
      await controls.assignSelectedLabel(label, 'unassign');
    });
    expect(reads.at(-1)).toBe('a');
    expect(calls).toHaveLength(sent);
    expect(controls.labelOutcomes[0]!.status).toBe('not-attempted');
  } finally {
    release?.();
    await act(async () => root.unmount());
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
