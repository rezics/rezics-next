import { expect, test } from 'bun:test';
import { admitRecentCursor, admitRecentWrite } from '../src/search/recent-request';

const accountId = '019f0000-0000-7000-8000-734100000001';
const id = '019f0000-0000-7000-8000-734100000002';
const key = '019f0000-0000-7000-8000-734100000003';
const queuedAt = '2026-10-30T12:00:00.000Z';
const query = { kind: 'query' as const, text: 'book', languages: ['en'] };
const scope = { kind: 'collection' as const, id };

function write(change: unknown, extra: Record<string, unknown> = {}) {
  return { accountId, expectedRevision: 4, pending: { key, queuedAt, change, ...extra } };
}

test('admits use, remove, clear and an optional native cursor', () => {
  expect(admitRecentWrite(write({ kind: 'use', entry: query })).pending.change).toEqual({
    kind: 'use',
    entry: query,
  });
  expect(admitRecentWrite(write({ kind: 'use', entry: { ...query, scope } })).pending.change).toEqual({
    kind: 'use',
    entry: { ...query, scope },
  });
  expect(admitRecentWrite(write({ kind: 'remove', id })).pending.change).toEqual({ kind: 'remove', id });
  expect(admitRecentWrite(write({ kind: 'clear' })).pending.change).toEqual({ kind: 'clear' });
  expect(
    admitRecentWrite({
      ...write({ kind: 'clear' }),
      pending: { key, queuedAt, change: { kind: 'clear' }, localId: 'row', visitedAt: 1, expectedRevision: 4 },
    }).pending,
  ).toEqual({ key, queuedAt, change: { kind: 'clear' } });
  expect(admitRecentCursor(undefined)).toBeUndefined();
  expect(admitRecentCursor('')).toBeUndefined();
  expect(admitRecentCursor('opaque-cursor')).toBe('opaque-cursor');
});

test('primitive and container failures stay out of native dispatch', () => {
  for (const input of [null, 0, 'x', true, [], { accountId, expectedRevision: 4 }])
    expect(() => admitRecentWrite(input)).toThrow('Invalid recent request');
  expect(() => admitRecentCursor(1)).toThrow('Invalid recent request');
  expect(() => admitRecentCursor({ cursor: 'x' })).toThrow('Invalid recent request');
  expect(() => admitRecentCursor('x'.repeat(4097))).toThrow('Invalid recent request');
});

test('unknown kind, missing change, and invalid revision, entry or remove never become a remove command', () => {
  expect(() => admitRecentWrite(write({ kind: 'rename', id }))).toThrow('Invalid recent request');
  expect(() => admitRecentWrite(write({ kind: 'use', id, entry: query }))).toThrow('Invalid recent request');
  expect(() => admitRecentWrite({ accountId, expectedRevision: 4, pending: { key, queuedAt } })).toThrow(
    'Invalid recent request',
  );
  expect(() => admitRecentWrite({ ...write({ kind: 'clear' }), expectedRevision: 1.5 })).toThrow(
    'Invalid recent request',
  );
  expect(() => admitRecentWrite(write({ kind: 'use', entry: { kind: 'query', text: '  ' } }))).toThrow(
    'Invalid recent request',
  );
  expect(() =>
    admitRecentWrite(write({ kind: 'use', entry: { kind: 'query', text: 'book', languages: ['not a tag'] } })),
  ).toThrow('Invalid recent request');
  expect(() => admitRecentWrite(write({ kind: 'remove', id: `pending:${key}` }))).toThrow('Invalid recent request');
  expect(() => admitRecentWrite(write({ kind: 'remove', id: `local:${id}` }))).toThrow('Invalid recent request');
});
