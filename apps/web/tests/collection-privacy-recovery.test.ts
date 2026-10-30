import { expect, test } from 'bun:test';
import {
  CollectionPrivacyEditor,
  CollectionPrivacyPager,
  type VisibilityAttempt,
  type CollectionPrivacyIO,
} from '../src/settings/collection-privacy-recovery';
import type { OwnedCollection } from '../src/settings/preferences';
import type { CollectionPrivacyRead } from '../src/settings/collection-privacy-data';

const initial: OwnedCollection = { id: 'collection-1', title: 'Books to revisit', visibility: 'private', revision: 7 };
const receipt: OwnedCollection = { ...initial, visibility: 'public', revision: 8 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('A lost Collection visibility save retains the exact attempted revision/input/key and gives an honest retry or current readback without silently losing the chosen visibility', async () => {
  const commands: VisibilityAttempt[] = [];
  const readback = deferred<CollectionPrivacyRead<OwnedCollection>>();
  let reads = 0;
  const editor = new CollectionPrivacyEditor(initial, {
    save: async (input) => {
      commands.push(input);
      if (commands.length === 1) throw new Error('Response lost after commit');
      return { ok: true, collection: receipt };
    },
    read: async (id) => {
      expect(id).toBe(initial.id);
      reads++;
      return readback.promise;
    },
  });
  await editor.edit('public');
  const original = editor.snapshot().attempt!;
  expect(original).toEqual({
    collectionId: initial.id,
    revision: 7,
    visibility: 'public',
    idempotencyKey: expect.any(String),
  });
  expect(Object.isFrozen(original)).toBe(true);
  expect(editor.snapshot()).toMatchObject({ current: initial, desired: 'public', phase: 'uncertain' });
  await editor.edit('unlisted');
  const retry = editor.retry();
  await editor.retry();
  // Give the replay receipt a chance to start its one native readback.
  await Promise.resolve();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(original);
  expect(commands[1]).toBe(original);
  expect(editor.snapshot().phase).toBe('reloading');
  await editor.edit('private');
  readback.resolve({ ok: true, value: { ...initial, visibility: 'unlisted', revision: 10 } });
  await retry;
  expect(reads).toBe(1);
  expect(editor.snapshot()).toMatchObject({
    current: { revision: 10, visibility: 'unlisted' },
    desired: 'private',
    attempt: null,
    phase: 'review',
  });
  expect(commands).toHaveLength(2);
  // Only an explicit Save can submit the later draft against the newly read revision.
  await editor.submit();
  expect(commands[2]).toMatchObject({ collectionId: initial.id, revision: 10, visibility: 'private' });
  expect(commands[2]!.idempotencyKey).not.toBe(original.idempotencyKey);
  expect(editor.snapshot().phase).not.toBe('saved'); // The old receipt cannot confirm this new command.
});

test('definite conflict and refusal retain the choice until Reload deliberately adopts the current native row', async () => {
  for (const reason of ['conflict', 'forbidden', 'closed', 'invalid'] as const) {
    let readFails = true;
    const current = { ...initial, visibility: 'unlisted' as const, revision: 12 };
    const editor = new CollectionPrivacyEditor(initial, {
      save: async () => ({ ok: false, reason }),
      read: async () => (readFails ? { ok: false, reason: 'unavailable' } : { ok: true, value: current }),
    });
    await editor.edit('public');
    expect(editor.snapshot()).toMatchObject({
      current: initial,
      desired: 'public',
      attempt: null,
      phase: reason === 'conflict' ? 'conflict' : 'refused',
    });
    await editor.reload();
    expect(editor.snapshot().desired).toBe('public');
    readFails = false;
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({ current, desired: 'unlisted', attempt: null, phase: 'idle' });
  }
});

test('pending drafting and unavailable or stale recovery reads never claim saved or lose the original command', async () => {
  const saving = deferred<Awaited<ReturnType<CollectionPrivacyIO['save']>>>();
  const pending = new CollectionPrivacyEditor(initial, {
    save: () => saving.promise,
    read: async () => ({ ok: true, value: receipt }),
  });
  const first = pending.edit('public');
  await pending.edit('unlisted');
  saving.resolve({ ok: true, collection: receipt });
  await first;
  expect(pending.snapshot()).toMatchObject({ current: receipt, desired: 'unlisted', phase: 'review', attempt: null });
  for (const read of [
    { ok: false, reason: 'unavailable' },
    { ok: false, reason: 'closed' },
    { ok: false, reason: 'forbidden' },
    { ok: true, value: initial },
    { ok: true, value: { ...receipt, visibility: 'private' } },
  ] satisfies CollectionPrivacyRead<OwnedCollection>[]) {
    let calls = 0;
    const editor = new CollectionPrivacyEditor(initial, {
      save: async () => (++calls === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, collection: receipt }),
      read: async () => read,
    });
    await editor.edit('public');
    const attempt = editor.snapshot().attempt;
    await editor.retry();
    expect(editor.snapshot()).toMatchObject({ current: initial, desired: 'public', phase: 'uncertain', attempt });
  }
});

test('Failed owner-list paging retains existing rows/cursor and offers retry without unhandled rejection, duplicate rows or false empty success', async () => {
  const reads: (string | null)[] = [];
  const next = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
  const pager = new CollectionPrivacyPager(async (cursor) => {
    reads.push(cursor);
    if (reads.length === 1) return { ok: true, value: { collections: [initial], next: 'opaque+/cursor==' } };
    if (reads.length === 2) throw new Error('Next page unavailable');
    return next.promise;
  });
  await pager.load();
  await pager.load();
  expect(pager.snapshot()).toEqual({
    collections: [initial],
    next: 'opaque+/cursor==',
    loaded: true,
    loading: false,
    failure: 'unavailable',
  });
  const retry = pager.load();
  await pager.load();
  expect(reads).toEqual([null, 'opaque+/cursor==', 'opaque+/cursor==']);
  next.resolve({ ok: true, value: { collections: [initial, { ...initial, id: 'collection-2' }], next: null } });
  await retry;
  expect(pager.snapshot().collections.map((row) => row.id)).toEqual(['collection-1', 'collection-2']);
  expect(pager.snapshot()).toMatchObject({ next: null, failure: null, loading: false });
  await pager.load();
  expect(reads).toHaveLength(3);
});

test('first-page refusal is distinct from genuine empty, and a disposed account cannot populate a new journey', async () => {
  for (const reason of ['closed', 'forbidden', 'unavailable'] as const) {
    const pager = new CollectionPrivacyPager(async () => ({ ok: false, reason }));
    await pager.load();
    expect(pager.snapshot()).toMatchObject({ loaded: false, failure: reason, collections: [], next: null });
  }
  const empty = new CollectionPrivacyPager(async () => ({ ok: true, value: { collections: [], next: null } }));
  await empty.load();
  expect(empty.snapshot()).toMatchObject({ loaded: true, failure: null, collections: [], next: null });
  const response = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
  const previous = new CollectionPrivacyPager(() => response.promise);
  const loading = previous.load();
  previous.dispose();
  response.resolve({ ok: true, value: { collections: [initial], next: 'old-account' } });
  await loading;
  expect(previous.snapshot().collections).toEqual([]);
  expect(empty.snapshot().collections).toEqual([]);
});

test('a replay refused before receipt lookup cannot discard an earlier unknown-outcome command', async () => {
  for (const reason of ['closed', 'forbidden', 'invalid'] as const) {
    let calls = 0;
    const editor = new CollectionPrivacyEditor(initial, {
      save: async () => (++calls === 1 ? { ok: false, reason: 'unavailable' } : { ok: false, reason }),
      read: async () => ({ ok: true, value: receipt }),
    });
    await editor.edit('public');
    const attempt = editor.snapshot().attempt;
    await editor.edit('unlisted');
    await editor.retry();
    expect(editor.snapshot()).toMatchObject({ phase: 'uncertain', desired: 'unlisted', failure: reason });
    expect(editor.snapshot().attempt).toBe(attempt);
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({ phase: 'idle', current: receipt, desired: 'public', attempt: null });
  }
});
