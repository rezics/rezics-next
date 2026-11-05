import { expect, test } from 'bun:test';
import {
  decodeBoardCursor,
  decodeBoardRankCursor,
  encodeBoardCursor,
  encodeBoardRankCursor,
  normalizeBoardQuery,
  type BoardCursorBinding,
} from '../../src/content/board-cursor.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../../src/tokens/cursor.ts';
import { seal, type KeyRing } from '../../src/tokens/seal.ts';

const key = (byte: number) => new Uint8Array(32).fill(byte);
const ring: KeyRing = { current: 1, keys: new Map([[1, key(1)]]) };
const rotated: KeyRing = {
  current: 2,
  keys: new Map([
    [1, key(1)],
    [2, key(2)],
  ]),
};
const now = Date.UTC(2026, 9, 25, 12);
const viewerAccountId = '01890f3e-7c00-7000-8000-000000000002';
const binding: BoardCursorBinding = {
  boardId: '01890f3e-7c00-7000-8000-000000000001',
  query: 'red fox',
  sort: 'newest',
  pinRevision: '9',
  viewer: { kind: 'account', accountId: viewerAccountId },
};
const after = { createdAt: '2026-10-25T11:59:58.123456Z', threadId: '01890f3e-7c00-7000-8000-000000000003' };
const expectedCoreBinding: CursorBinding = {
  operation: 'board.threads.list',
  parameters: {
    boardId: binding.boardId,
    query: binding.query,
    sort: binding.sort,
    viewer: viewerAccountId,
    representation: 'pinned-cohort-v2',
    pinRevision: binding.pinRevision,
  },
};

test('a board cursor binds board, normalized query, sort, verified viewer and current epoch', () => {
  const normalizedBinding = { ...binding, query: '  red fox  ' };
  const token = encodeBoardCursor(ring, normalizedBinding, 7, after, now);

  expect(normalizeBoardQuery('  red fox\n')).toBe('red fox');
  expect(decodeBoardCursor(ring, binding, token, 7, now)).toEqual({ ok: true, epoch: 7, after });
  const core = decodeCursor(ring, expectedCoreBinding, token, now);
  expect(core).toMatchObject({ ok: true, epoch: 7 });
  if (!core.ok) throw new Error('Expected signed cursor');
  expect(core.after[0]).toBe(ring.current);
  expect(JSON.stringify(core.after)).not.toContain(after.threadId);
  expect(JSON.stringify(core.after)).not.toContain(after.createdAt);
  const oldToken = encodeCursor(
    ring,
    {
      operation: 'board.threads.list',
      parameters: { boardId: binding.boardId, query: binding.query, sort: binding.sort, viewer: viewerAccountId },
    },
    { epoch: 7, after: [after.createdAt, after.threadId] },
    now,
  );
  expect(decodeBoardCursor(ring, binding, oldToken, 7, now)).toEqual({ ok: false, reason: 'invalid' });

  for (const other of [
    { ...binding, boardId: '01890f3e-7c00-7000-8000-000000000004' },
    { ...binding, query: 'blue fox' },
    { ...binding, pinRevision: '10' },
    { ...binding, sort: 'oldest' as const },
    { ...binding, viewer: { kind: 'anonymous' as const } },
    { ...binding, viewer: { kind: 'account' as const, accountId: '01890f3e-7c00-7000-8000-000000000005' } },
  ])
    expect(decodeBoardCursor(ring, other, token, 7, now)).toEqual({ ok: false, reason: 'invalid' });

  expect(decodeBoardCursor(ring, binding, token, 8, now)).toEqual({ ok: false, reason: 'stale' });
  expect(decodeBoardCursor(ring, binding, `${token}x`, 7, now)).toEqual({ ok: false, reason: 'invalid' });
});

test('board cursors use core signing, key rotation, tamper detection and the trusted clock for expiry', () => {
  const token = encodeBoardCursor(ring, binding, 7, after, now);
  expect(decodeBoardCursor(rotated, binding, token, 7, now)).toEqual({ ok: true, epoch: 7, after });

  const rotatedToken = encodeBoardCursor(rotated, binding, 7, after, now);
  expect(decodeBoardCursor(ring, binding, rotatedToken, 7, now)).toEqual({ ok: false, reason: 'invalid' });
  expect(decodeBoardCursor(ring, binding, `${token.slice(0, -1)}x`, 7, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(decodeBoardCursor(ring, binding, token, 7, now + 15 * 60_000)).toEqual({
    ok: true,
    epoch: 7,
    after,
  });
  expect(decodeBoardCursor(ring, binding, token, 7, now + 15 * 60_000 + 1)).toEqual({
    ok: false,
    reason: 'expired',
  });
});

test('malformed signed board keysets and authored input are rejected without decoder exceptions', () => {
  const scope = `cursor\0board.threads.list\0{"boardId":${JSON.stringify(binding.boardId)},"pinRevision":"9","query":"red fox","representation":"pinned-cohort-v2","sort":"newest","viewer":${JSON.stringify(viewerAccountId)}}`;
  const malformed = [
    [],
    [after.createdAt],
    [after.createdAt, after.threadId, 'extra'],
    ['not-a-time', after.threadId],
    ['2026-02-30T12:00:00Z', after.threadId],
    [after.createdAt, 'not-a-uuid'],
    [after.createdAt, '01890f3e-7c00-7000-8000-00000000000Z'],
    [1, after.threadId],
  ];

  for (const keyset of malformed) {
    const token = seal(ring, scope, { e: 7, a: keyset, t: now });
    expect(() => decodeBoardCursor(ring, binding, token, 7, now)).not.toThrow();
    expect(decodeBoardCursor(ring, binding, token, 7, now)).toEqual({ ok: false, reason: 'invalid' });
  }

  expect(() => decodeBoardCursor(ring, binding, 'not a cursor', 7, now)).not.toThrow();
  expect(decodeBoardCursor(ring, binding, 'not a cursor', 7, now)).toEqual({ ok: false, reason: 'invalid' });
});

test('ranked continuations retain exact rank, hidden boundaries and the same pin revision', () => {
  for (const sort of ['active', 'hot'] as const) {
    const ranked = { ...binding, sort };
    const position = { rank: 0.12345678901234567, threadId: after.threadId };
    const token = encodeBoardRankCursor(ring, ranked, 7, position, now);
    expect(decodeBoardRankCursor(rotated, ranked, token, 7, now)).toEqual({ ok: true, epoch: 7, after: position });
    expect(decodeBoardRankCursor(ring, { ...ranked, pinRevision: '11' }, token, 7, now).ok).toBe(false);
    expect(decodeBoardRankCursor(ring, { ...ranked, sort: sort === 'hot' ? 'active' : 'hot' }, token, 7, now).ok).toBe(
      false,
    );
  }
});
