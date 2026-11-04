import { expect, test } from 'bun:test';
import {
  normalizeBoardPinAdviceSelection,
  projectBoardPinAdvice,
  type BoardPinAdviceObservation,
} from '../../src/content/board-pin-advice.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';

const boardId = '0199f001-0000-7000-8000-000000000001';
const threadId = '0199f002-0000-7000-8000-001000000002';
const sourceRevisionId = '0199f002-0000-7000-8000-001000000003';
const selection = [{ threadId, placeId: boardId, sourceRevisionId }];
const observation = (): BoardPinAdviceObservation => ({
  boardId,
  boardWitness: 'original-board',
  pinRevision: '4',
  pinIds: [],
  management: true,
  sourcesCurrent: true,
  sources: [{ ...selection[0]!, witness: 'original-thread' }],
  epochs: new Map([[1, 1]]),
});

test('createKernel mounts pin advice with its authenticated action, separate from board reads', () => {
  const kernel = createKernel({
    pool: { on: () => {} } as never,
    routeKey: new Uint8Array(32).fill(7),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
    receiptKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
  });
  const actions = actionCatalogue(kernel);
  expect(actions.get('board:read')?.anonymous).toBe(true);
  expect(actions.get('board:pin-advice')?.anonymous).toBe(false);
});

// These are composition outcomes, not native authority or growth evidence.
test('selected advice rejects duplicates, oversize and foreign places before observing native data', () => {
  expect(normalizeBoardPinAdviceSelection(boardId, selection)).toEqual(selection);
  for (const invalid of [
    [...selection, ...selection],
    Array.from({ length: 26 }, () => selection[0]!),
    [{ ...selection[0]!, placeId: threadId }],
    [{ ...selection[0]!, sourceRevisionId: 'not-an-id' }],
    [{ ...selection[0]!, sourceRevisionId: boardId }],
  ])
    expect(() => normalizeBoardPinAdviceSelection(boardId, invalid)).toThrow();
});

test('only current native curation advice permits a selected pin, even when other pins are hidden', () => {
  const before = observation();
  const full = { ...before, pinIds: Array.from({ length: 5 }, (_, i) => `hidden-${i}`) };
  const allowed = projectBoardPinAdvice('viewer', selection, before, before);
  expect(allowed).toEqual({
    state: 'ready',
    boardId,
    viewer: { kind: 'account', id: 'viewer' },
    pinRevision: '4',
    management: 'allowed',
    threads: [{ threadId, pinned: false, actions: ['pin'] }],
  });
  expect(projectBoardPinAdvice('viewer', selection, full, full)).toMatchObject({
    threads: [{ threadId, pinned: false, actions: [] }],
  });
  expect(JSON.stringify(projectBoardPinAdvice('viewer', selection, full, full))).not.toContain('hidden');
  const pinned = { ...full, pinIds: [threadId, ...full.pinIds.slice(1)] };
  expect(projectBoardPinAdvice('viewer', selection, pinned, pinned)).toMatchObject({
    threads: [{ threadId, pinned: true, actions: ['unpin'] }],
  });
  expect(projectBoardPinAdvice('viewer', selection, before, { ...before, management: false })).toMatchObject({
    management: 'denied',
    threads: [{ threadId, pinned: false, actions: [] }],
  });
});

test('a changed pin generation, source, parent or home cannot refresh old selected authority', () => {
  const before = observation();
  for (const after of [
    { ...before, sourcesCurrent: false }, // Source changed during final foreign preparation.
    { ...before, pinRevision: '6' }, // Includes pin/unpin ABA.
    { ...before, boardWitness: 'another-parent' },
    { ...before, sources: [{ ...selection[0]!, witness: 'new-source' }] },
    { ...before, epochs: new Map([[1, 2]]) },
  ])
    expect(projectBoardPinAdvice('viewer', selection, before, after)).toEqual({ state: 'stale' });
  expect(projectBoardPinAdvice('viewer', selection, before, before, '3')).toEqual({ state: 'stale' });
  expect(() => projectBoardPinAdvice('viewer', selection, before, { ...before, sources: [] })).toThrow();
});
