import { expect, test } from 'bun:test';
import {
  boardPinAdviceInput,
  inspectBoardPinAdvice,
  nativeBoardPinAdvice,
  type BoardPinAdviceQuery,
  type BoardPinAdviceWire,
} from '../src/threads/board-pins/advice';

const boardId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b3';
const threadId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b4';
const sourceRevisionId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b5';
const viewerId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b6';
const selected = [{ threadId, placeId: boardId, sourceRevisionId }];
const query = (): BoardPinAdviceQuery => ({
  boardId,
  viewerId,
  selected,
  pinRevision: '4',
  signal: new AbortController().signal,
});
const ready = () => ({
  state: 'ready',
  boardId,
  viewer: { kind: 'account', id: viewerId },
  pinRevision: '4',
  management: 'allowed',
  threads: [{ threadId, pinned: true, actions: ['unpin'] }],
});
const wire = (data: unknown, status = 200): BoardPinAdviceWire => ({ post: async () => ({ status, data }) });

test('selected advice rejects duplicates, foreign parents, malformed revisions and open inputs before transport', async () => {
  const invalid = [
    { selected: [...selected, ...selected] },
    { selected: [{ ...selected[0], placeId: viewerId }] },
    { selected: [{ ...selected[0], sourceRevisionId: 'head' }] },
    { selected: Array(26).fill(selected[0]) },
    { selected, pinRevision: '9223372036854775808' },
    { selected, pinRevision: '-1' },
    { selected, actions: ['pin'] },
    { selected: [{ ...selected[0], pinned: true }] },
  ];
  for (const input of invalid) expect(boardPinAdviceInput(boardId, input)).toBeUndefined();
  let calls = 0;
  await inspectBoardPinAdvice(
    { ...query(), selected: [...selected, ...selected] },
    {
      post: async () => {
        calls++;
        return { status: 200, data: ready() };
      },
    },
    'Bearer original',
  );
  expect(calls).toBe(0);
});

test('inspection sends frozen exact operands and credentials with cancellation and no-store', async () => {
  const current = query();
  const result = await inspectBoardPinAdvice(
    current,
    {
      post: async (input, options) => {
        expect(input).toEqual({ selected, pinRevision: '4' });
        expect(Object.isFrozen(input.selected[0])).toBe(true);
        expect(options).toEqual({
          headers: { authorization: 'Bearer original' },
          fetch: { signal: current.signal, cache: 'no-store' },
        });
        return { status: 200, data: ready() };
      },
    },
    'Bearer original',
  );
  expect(result).toEqual(ready());
  expect(Object.isFrozen(result)).toBe(true);
});

test('advice binds viewer, board, generation and only selected IDs; denial and full capacity invent no actions', async () => {
  const malformed = [
    { ...ready(), viewer: { kind: 'account', id: threadId } },
    { ...ready(), boardId: threadId },
    { ...ready(), pinRevision: '5' },
    { ...ready(), threads: [] },
    { ...ready(), threads: [{ threadId: viewerId, pinned: true, actions: ['unpin'] }] },
    { ...ready(), management: 'denied' },
    { ...ready(), threads: [{ threadId, pinned: true, actions: ['pin'] }] },
    { ...ready(), hiddenPins: [viewerId] },
  ];
  for (const body of malformed)
    expect(await inspectBoardPinAdvice(query(), wire(body), 'credential')).toEqual({ state: 'unavailable' });
  const denied = { ...ready(), management: 'denied', threads: [{ threadId, pinned: true, actions: [] }] };
  expect(await inspectBoardPinAdvice(query(), wire(denied), 'credential')).toEqual(denied);
  const full = { ...ready(), threads: [{ threadId, pinned: false, actions: [] }] };
  expect(await inspectBoardPinAdvice(query(), wire(full), 'credential')).toEqual(full);
  for (const status of [401, 403, 404])
    expect(await inspectBoardPinAdvice(query(), wire({}, status), 'credential')).toEqual({ state: 'denied' });
  expect(await inspectBoardPinAdvice(query(), wire({ state: 'stale' }), 'credential')).toEqual({ state: 'stale' });
});

test('absent published methods and aborted late completions stay unavailable', async () => {
  expect(nativeBoardPinAdvice({ threads: {} })).toBeUndefined();
  expect(nativeBoardPinAdvice({ 'pin-advice': {} })).toBeUndefined();
  const method = wire(ready());
  expect(nativeBoardPinAdvice({ 'pin-advice': method })).toBe(method);
  expect(await inspectBoardPinAdvice(query(), undefined, 'credential')).toEqual({ state: 'unavailable' });
  const controller = new AbortController();
  const result = await inspectBoardPinAdvice(
    { ...query(), signal: controller.signal },
    {
      post: async () => {
        controller.abort();
        return { status: 200, data: ready() };
      },
    },
    'credential',
  );
  expect(result).toEqual({ state: 'unavailable' });
});
