import { expect, test } from 'bun:test';
import {
  captureShelfLabelEntry,
  executeShelfLabelRequest,
  type ShelfLabelRequest,
} from '../src/library/shelf-label-request';
import type { ShelfLabelIntent, ShelfLabelOutcome } from '../src/library/shelf-selection';
import type { PersonalLibraryEntry } from '../src/library/entries-read';

const entry = (id: string): PersonalLibraryEntry => ({
  subjectId: id,
  revision: 2,
  incarnationId: `life-${id}`,
  changeKey: `state-${id}`,
  removeKey: `remove-${id}`,
  state: 'reading',
  createdAt: '',
  updatedAt: '',
  subject: null,
});
const request = (kind: ShelfLabelRequest['kind'], rows: PersonalLibraryEntry[]): ShelfLabelRequest => ({
  id: 'operation',
  kind,
  label: { id: 'label', name: 'Revisit' },
  targets: rows.map((row) => ({ entry: captureShelfLabelEntry(row), title: row.subjectId })),
});

test('a removal serializes captured assignment CAS, skips absent labels and leaves other personal facts alone', async () => {
  const rows = [entry('a'), entry('b'), entry('c')];
  const before = structuredClone(rows);
  const operation = request('unassign', rows);
  const mutations: ShelfLabelIntent[] = [];
  const outcomes: [string, ShelfLabelOutcome['status']][] = [];
  let active = 0;
  let max = 0;
  await executeShelfLabelRequest(operation, {
    isCurrent: () => true,
    entry: (id) => rows.find((row) => row.subjectId === id),
    readAssignment: async (id, labelId) => {
      expect(labelId).toBe('label');
      return { ok: true, assignment: id === 'b' ? null : { id: `assignment-${id}`, revision: 7 } };
    },
    mutate: async (intent) => {
      max = Math.max(max, ++active);
      await Promise.resolve();
      mutations.push(intent);
      active--;
      return { status: 'removed' };
    },
    record: (id, result) => outcomes.push([id, result.status]),
  });
  expect(mutations.map((intent) => intent.input)).toEqual(
    ['a', 'c'].map((subjectId) => ({
      intent: 'unassign',
      subjectId,
      labelId: 'label',
      assignmentId: `assignment-${subjectId}`,
      revision: 7,
      idempotencyKey: expect.any(String),
    })),
  );
  expect(mutations.every((intent) => intent.operationId === operation.id)).toBe(true);
  expect(new Set(mutations.map((intent) => intent.input.idempotencyKey)).size).toBe(2);
  expect(outcomes).toEqual([
    ['a', 'removed'],
    ['b', 'unchanged'],
    ['c', 'removed'],
  ]);
  expect(rows).toEqual(before);
  expect(max).toBe(1);
});

test('changed revisions stop removal after its read, and retirement drops old callbacks before a write', async () => {
  for (const retired of [false, true]) {
    const row = entry('a');
    const operation = request('unassign', [row, entry('b')]);
    let current = true;
    const outcomes: string[] = [];
    let writes = 0;
    await executeShelfLabelRequest(operation, {
      isCurrent: () => current,
      entry: () => row,
      readAssignment: async () => {
        if (retired) current = false;
        else row.revision++;
        return { ok: true, assignment: { id: 'assignment-a', revision: 7 } };
      },
      mutate: async () => {
        writes++;
        return { status: 'removed' };
      },
      record: (_, result) => outcomes.push(result.status),
    });
    expect(writes).toBe(0);
    expect(outcomes).toEqual(retired ? [] : ['conflicted']);
  }
});

test('an assignment uses only the captured targets and stops at uncertainty', async () => {
  const rows = [entry('a'), entry('b'), entry('c')];
  const selection = rows.slice(0, 2);
  const operation = request('assign', selection);
  selection.splice(0, 2, rows[2]!);
  const sent: string[] = [];
  const outcomes: string[] = [];
  await executeShelfLabelRequest(operation, {
    isCurrent: () => true,
    entry: (id) => rows.find((row) => row.subjectId === id),
    readAssignment: async () => {
      throw new Error('assign must not read assignments');
    },
    mutate: async (intent) => {
      sent.push(intent.input.subjectId);
      return { status: 'unknown' };
    },
    record: (_, result) => outcomes.push(result.status),
  });
  expect(sent).toEqual(['a']);
  expect(outcomes).toEqual(['unknown']);
  expect(operation.targets.map((target) => target.entry.subjectId)).toEqual(['a', 'b']);
});
