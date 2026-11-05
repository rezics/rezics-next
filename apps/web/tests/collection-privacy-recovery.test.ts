import { expect, test } from 'bun:test';
import {
  CollectionPrivacyEditor,
  CollectionPrivacyPager,
  type VisibilityAttempt,
  type CollectionPrivacyIO,
} from '../src/settings/collection-privacy-recovery';
import { managedReadTimeout } from '../src/settings/managed-read-deadline';
import type { OwnedCollection } from '../src/settings/preferences';
import type { CollectionPrivacyRead } from '../src/settings/collection-privacy-data';

const row = (visibility: OwnedCollection['visibility'], revision: number): OwnedCollection => ({
  id: 'collection-1',
  title: 'Books to revisit',
  kind: 'curated',
  membershipKind: 'curated',
  visibility,
  revision,
  allowedVisibilityActions: (['private', 'unlisted', 'public'] as const).filter((value) => value !== visibility),
});
const initial = row('private', 7);
const receipt = row('public', 8);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flushPromiseJobs = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

const withControlledTimeout = async (run: (expire: () => void, delay: () => number | undefined) => Promise<void>) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let callback: (() => void) | undefined;
  let timeout: number | undefined;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number) => {
    timeout = delay;
    callback = handler as unknown as () => void;
    return 1 as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    await run(
      () => {
        const current = callback;
        callback = undefined;
        current?.();
      },
      () => timeout,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
};

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
      return reads === 1 ? { ok: true, value: row('unlisted', 9) } : readback.promise;
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
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({
    current: { revision: 9, visibility: 'unlisted' },
    desired: 'unlisted',
    phase: 'uncertain',
    attempt: original,
  });
  const retry = editor.retry();
  await editor.retry();
  await flushPromiseJobs();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(original);
  expect(commands[1]).toBe(original);
  expect(editor.snapshot().phase).toBe('reloading');
  await editor.edit('private');
  readback.resolve({ ok: true, value: row('unlisted', 10) });
  await retry;
  expect(reads).toBe(2);
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

test('empty current update advice blocks a retained original replay and refreshed advice restores it when the target already matches', async () => {
  let now = 1_000;
  let reads = 0;
  const commands: VisibilityAttempt[] = [];
  const alreadyApplied = { ...row('public', 8), allowedVisibilityActions: ['private', 'unlisted'] as const };
  const editor = new CollectionPrivacyEditor(
    initial,
    {
      save: async (input) => {
        commands.push(input);
        return {
          ok: false,
          reason: 'unavailable',
          failure: { status: 503, ...(commands.length === 1 ? { retryAfter: '60' } : {}) },
        };
      },
      read: async () => ({
        ok: true,
        value: ++reads === 1 ? { ...alreadyApplied, allowedVisibilityActions: [] } : alreadyApplied,
      }),
    },
    undefined,
    undefined,
    () => now,
  );

  await editor.edit('public');
  const original = editor.snapshot().attempt!;
  const retainedRetry = editor.retry.bind(editor);
  await editor.edit('unlisted');
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({
    current: { revision: 8, visibility: 'public', allowedVisibilityActions: [] },
    desired: 'unlisted',
    phase: 'uncertain',
    attempt: original,
    outcomeUnknown: true,
  });
  const commandWait = editor.commandRetryDeadline();
  now = commandWait;
  await retainedRetry();
  expect(commands).toEqual([original]);
  expect(editor.commandRetryDeadline()).toBe(commandWait);

  await editor.reload();
  await retainedRetry();
  expect(commands).toEqual([original, original]);
  expect(commands[1]).toBe(original);
  expect(editor.snapshot()).toMatchObject({
    current: { visibility: 'public', allowedVisibilityActions: ['private', 'unlisted'] },
    desired: 'unlisted',
    phase: 'uncertain',
    attempt: original,
  });
});

test('an original command wait survives a shorter current-read refusal and retained retry callback', async () => {
  let now = 1_000;
  let reads = 0;
  const commands: VisibilityAttempt[] = [];
  const editor = new CollectionPrivacyEditor(
    initial,
    {
      save: async (input) => {
        commands.push(input);
        return {
          ok: false,
          reason: 'unavailable',
          failure: { status: 503, ...(commands.length === 1 ? { retryAfter: '60' } : {}) },
        };
      },
      read: async () =>
        ++reads === 1
          ? { ok: false, reason: 'unavailable', failure: { status: 503, retryAfter: '5' } }
          : { ok: true, value: row('unlisted', 9) },
    },
    undefined,
    undefined,
    () => now,
  );
  await editor.edit('public');
  const original = editor.snapshot().attempt!;
  const retainedRetry = editor.retry.bind(editor);
  await editor.edit('unlisted');
  await editor.reload();
  expect(editor.commandRetryDeadline()).toBe(61_000);
  expect(editor.currentReadRetryDeadline()).toBe(6_000);
  await editor.reload();
  await retainedRetry();
  expect(reads).toBe(1);
  expect(commands).toEqual([original]);
  now = 6_000;
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({ current: { revision: 9 }, desired: 'unlisted', attempt: original });
  expect(editor.commandRetryDeadline()).toBe(61_000);
  now = 61_000;
  await retainedRetry();
  expect(commands).toEqual([original, original]);
  expect(editor.snapshot()).toMatchObject({ phase: 'uncertain', attempt: original, outcomeUnknown: true });
});

test('a failed inventory cursor gates exact retry and cursor-free restart until the endpoint wait expires', async () => {
  let now = 1_000;
  const reads: (string | null)[] = [];
  const pager = new CollectionPrivacyPager(
    async (cursor) => {
      reads.push(cursor);
      if (reads.length === 1) return { ok: true, value: { collections: [initial], next: 'exact-next-page' } };
      if (reads.length === 2) return { ok: false, reason: 'unavailable', failure: { status: 503, retryAfter: '30' } };
      return { ok: true, value: { collections: [receipt], next: null } };
    },
    undefined,
    () => now,
  );
  await pager.load();
  await pager.load();
  const retry = pager.load.bind(pager);
  const restart = pager.restart.bind(pager);
  await retry();
  expect(reads).toEqual([null, 'exact-next-page']);
  expect(pager.retryDeadline()).toBe(31_000);
  expect(pager.restartDeadline()).toBe(31_000);
  expect(pager.snapshot()).toMatchObject({ next: 'exact-next-page', failure: 'unavailable' });
  await retry();
  await restart();
  expect(reads).toEqual([null, 'exact-next-page']);

  now = 31_000;
  expect(reads).toEqual([null, 'exact-next-page']);
  await retry();
  await restart();
  expect(reads).toEqual([null, 'exact-next-page', 'exact-next-page', null]);
  expect(pager.snapshot()).toMatchObject({ collections: [receipt], next: null, failure: null, loaded: true });
});

test('retirement clears private waits and fences a late current-read refusal and retained callback', async () => {
  let now = 1_000;
  let saves = 0;
  const lateRead = deferred<CollectionPrivacyRead<OwnedCollection>>();
  const editor = new CollectionPrivacyEditor(
    initial,
    {
      save: async () => {
        saves++;
        return { ok: false, reason: 'unavailable', failure: { status: 503, retryAfter: '60' } };
      },
      read: async () => lateRead.promise,
    },
    undefined,
    undefined,
    () => now,
  );
  await editor.edit('public');
  const retainedRetry = editor.retry.bind(editor);
  const reload = editor.reload();
  editor.dispose();
  expect(editor.commandRetryDeadline()).toBe(0);
  lateRead.resolve({ ok: false, reason: 'unavailable', failure: { status: 503, retryAfter: '120' } });
  await reload;
  await retainedRetry();
  expect(editor.currentReadRetryDeadline()).toBe(0);
  expect(editor.commandRetryDeadline()).toBe(0);
  expect(saves).toBe(1);

  const pager = new CollectionPrivacyPager(
    async () => ({ ok: false, reason: 'unavailable', failure: { status: 503, retryAfter: '60' } }),
    undefined,
    () => now,
  );
  await pager.load();
  expect(pager.retryDeadline()).toBe(61_000);
  pager.dispose();
  expect(pager.retryDeadline()).toBe(0);
});

test('explicit local abandonment releases the row without claiming the original save was cancelled or absent', async () => {
  let saves = 0;
  const editor = new CollectionPrivacyEditor(initial, {
    save: async () => {
      saves++;
      throw new Error('Response lost');
    },
    read: async () => ({ ok: true, value: initial }),
  });
  await editor.edit('public');
  expect(editor.needsListRestartProtection()).toBe(true);
  editor.abandon();
  expect(editor.snapshot()).toMatchObject({
    current: initial,
    desired: 'private',
    attempt: null,
    phase: 'abandoned',
    outcomeUnknown: true,
  });
  expect(editor.needsListRestartProtection()).toBe(false);
  await editor.edit('public');
  expect(saves).toBe(1);
  expect(editor.snapshot().desired).toBe('private');
});

test('definite conflict and refusal retain the choice until Use current discards it', async () => {
  for (const reason of ['conflict', 'forbidden', 'closed', 'invalid'] as const) {
    let readFails = true;
    const current = { ...row('unlisted', 12), allowedVisibilityActions: ['private'] as const };
    const editor = new CollectionPrivacyEditor(initial, {
      save: async () => ({ ok: false, reason }),
      read: async () => (readFails ? { ok: false, reason: 'unavailable' } : { ok: true, value: current }),
    });
    await editor.edit('public');
    expect(editor.snapshot()).toMatchObject({
      current: initial,
      desired: 'public',
      intent: 'public',
      attempt: null,
      phase: reason === 'conflict' ? 'conflict' : 'refused',
    });
    await editor.reload();
    expect(editor.snapshot().desired).toBe('public');
    readFails = false;
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      current,
      desired: 'public',
      intent: 'public',
      attempt: null,
      phase: 'review',
    });
    await editor.submit();
    expect(editor.snapshot().attempt).toBeNull();
    editor.useCurrent();
    expect(editor.snapshot()).toMatchObject({ current, desired: 'unlisted', intent: undefined, phase: 'idle' });
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
    const deniedRead = !read.ok && (read.reason === 'closed' || read.reason === 'forbidden');
    expect(editor.snapshot()).toMatchObject({
      current: deniedRead ? null : initial,
      desired: 'public',
      phase: 'readback',
      attempt,
      receipt: { id: initial.id, revision: receipt.revision, visibility: receipt.visibility },
      outcomeUnknown: false,
    });
  }
});

test('Failed owner-list paging retains existing rows/cursor and offers retry without unhandled rejection, duplicate rows or false empty success', async () => {
  const reads: (string | null)[] = [];
  const next = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
  const firstPage = Array.from({ length: 20 }, (_, index) => ({ ...initial, id: `first-${index}` }));
  const secondPage = Array.from({ length: 20 }, (_, index) => ({ ...initial, id: `second-${index}` }));
  const pager = new CollectionPrivacyPager(async (cursor) => {
    reads.push(cursor);
    if (reads.length === 1) return { ok: true, value: { collections: firstPage, next: 'opaque+/cursor==' } };
    if (reads.length === 2) throw new Error('Next page unavailable');
    return next.promise;
  });
  await pager.load();
  await pager.load();
  expect(pager.snapshot()).toEqual({
    collections: firstPage,
    next: 'opaque+/cursor==',
    window: 1,
    loaded: true,
    loading: false,
    failure: 'unavailable',
  });
  const retry = pager.load();
  await pager.load();
  expect(reads).toEqual([null, 'opaque+/cursor==', 'opaque+/cursor==']);
  next.resolve({ ok: true, value: { collections: secondPage, next: null } });
  await retry;
  expect(pager.snapshot().collections).toEqual(secondPage);
  expect(pager.snapshot().collections).toHaveLength(20);
  expect(pager.snapshot()).toMatchObject({ next: null, window: 2, failure: null, loading: false });
  await pager.load();
  expect(reads).toHaveLength(3);
});

test('duplicate identities within one native page keep the first row', async () => {
  const duplicate = { ...initial, title: 'Later duplicate' };
  const pager = new CollectionPrivacyPager(async () => ({
    ok: true,
    value: { collections: [initial, duplicate], next: null },
  }));
  await pager.load();
  expect(pager.snapshot().collections).toEqual([initial]);
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
    expect(editor.snapshot()).toMatchObject({ phase: 'uncertain', current: receipt, desired: 'unlisted', attempt });
  }
});

test('an exhausted list refresh replaces old pages, and a failed refresh retries its first page honestly', async () => {
  const reads: (string | null)[] = [];
  const fresh = { ...row('unlisted', 10), title: 'Current reading' };
  const response = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
  const pager = new CollectionPrivacyPager(async (cursor) => {
    reads.push(cursor);
    if (reads.length === 1)
      return { ok: true, value: { collections: [initial, { ...initial, id: 'old-page-row' }], next: null } };
    if (reads.length === 2) throw new Error('Refresh unavailable');
    return response.promise;
  });
  await pager.load();
  await pager.load();
  expect(reads).toEqual([null]);
  await pager.restart();
  expect(pager.snapshot()).toMatchObject({
    collections: [initial, { ...initial, id: 'old-page-row' }],
    loaded: true,
    failure: 'unavailable',
    next: null,
    loading: false,
  });
  const guarded = new CollectionPrivacyEditor(initial, {
    save: async () => ({ ok: false, reason: 'unavailable' }),
    read: async () => ({ ok: true, value: initial }),
  });
  const unregister = pager.registerRow(guarded);
  await guarded.edit('public');
  await pager.load();
  expect(reads).toEqual([null, null]); // Retrying a failed replacement also protects new row decisions.
  expect(pager.retryReplacesRows()).toBe(true);
  await guarded.reload();
  unregister();
  const retry = pager.load();
  await pager.restart();
  await pager.load();
  expect(reads).toEqual([null, null, null]);
  expect(pager.snapshot()).toMatchObject({ loading: true, restarting: true });
  response.resolve({ ok: true, value: { collections: [fresh], next: null } });
  await retry;
  expect(pager.snapshot()).toMatchObject({ collections: [fresh], failure: null, loading: false, restarting: false });
  const editor = new CollectionPrivacyEditor(initial, {
    save: async () => ({ ok: false, reason: 'unavailable' }),
    read: async () => ({ ok: true, value: fresh }),
  });
  editor.receive(fresh);
  expect(editor.snapshot()).toMatchObject({ current: fresh, desired: 'unlisted', phase: 'idle' });
});

test('list restart cannot lose an unknown command or a later choice, and native denial still clears protected rows', async () => {
  const reads: (string | null)[] = [];
  const commands: VisibilityAttempt[] = [];
  let deny = false;
  const editor = new CollectionPrivacyEditor(initial, {
    save: async (input) => {
      commands.push(input);
      return commands.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, collection: receipt };
    },
    read: async () => ({ ok: true, value: receipt }),
  });
  const pager = new CollectionPrivacyPager(async (cursor) => {
    reads.push(cursor);
    return deny
      ? { ok: false, reason: 'forbidden' }
      : { ok: true, value: { collections: [initial], next: 'exact-next-page' } };
  });
  const unregister = pager.registerRow(editor);
  await pager.load();
  const saving = editor.edit('public');
  await pager.restart();
  expect(pager.snapshot().restartBlocked).toBe(true);
  expect(reads).toEqual([null]);
  await saving;
  const attempt = editor.snapshot().attempt;
  await editor.edit('unlisted');
  // Even choosing the last observed value cannot establish that the unknown command had no effect.
  await editor.edit('private');
  await pager.load();
  await pager.restart();
  expect(reads).toEqual([null]);
  expect(pager.snapshot().restartBlocked).toBe(true);
  editor.receive({ ...receipt, title: 'Replacement must not adopt this draft' });
  expect(editor.snapshot()).toMatchObject({ current: initial, desired: 'private', phase: 'uncertain' });
  expect(editor.snapshot().attempt).toBe(attempt);
  await editor.edit('unlisted');
  await editor.retry();
  expect(commands[1]).toBe(attempt);
  expect(editor.snapshot()).toMatchObject({ current: receipt, desired: 'unlisted', attempt: null, phase: 'review' });
  await pager.load();
  expect(reads).toEqual([null]); // A later draft also protects the current page from next-page replacement.
  await pager.restart();
  expect(reads).toEqual([null]); // A resolved original command does not discard the later unsaved choice.
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({ current: receipt, desired: 'unlisted', phase: 'review' });
  expect(pager.snapshot().restartBlocked).toBe(true);
  editor.useCurrent();
  expect(pager.snapshot().restartBlocked).toBe(false);
  await pager.restart();
  expect(reads).toEqual([null, null]);
  deny = true;
  await pager.load();
  expect(reads).toEqual([null, null, 'exact-next-page']);
  expect(pager.snapshot()).toMatchObject({ failure: 'forbidden', collections: [], next: null, loaded: false });
  unregister();
  expect(pager.snapshot().restartBlocked).toBe(false);
});

test('a late first-page restart cannot populate a replacement actor or cause another read', async () => {
  const response = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
  let reads = 0;
  const previous = new CollectionPrivacyPager(async () => {
    reads++;
    return reads === 1 ? { ok: true, value: { collections: [initial], next: null } } : response.promise;
  });
  await previous.load();
  const restart = previous.restart();
  previous.dispose();
  const before = previous.snapshot();
  const current = new CollectionPrivacyPager(async () => ({ ok: true, value: { collections: [], next: null } }));
  await current.load();
  response.resolve({ ok: true, value: { collections: [{ ...receipt, title: 'Late private title' }], next: 'old' } });
  await restart;
  expect(previous.snapshot()).toBe(before);
  expect(reads).toBe(2);
  expect(current.snapshot()).toMatchObject({ collections: [], loaded: true, next: null });
});

test('separate privacy write custody permits current row reads without creating a command or reserving a draft', async () => {
  let saves = 0;
  let reads = 0;
  const editor = new CollectionPrivacyEditor(
    initial,
    {
      read: async () => {
        reads++;
        return { ok: true, value: initial };
      },
      save: async () => {
        saves++;
        return { ok: true, collection: receipt };
      },
    },
    () => true,
    () => false,
  );
  await editor.reload();
  const before = editor.snapshot();
  await editor.edit('public');
  await editor.submit();
  await editor.retry();
  expect(editor.snapshot()).toBe(before);
  expect(editor.needsListRestartProtection()).toBe(false);
  expect(reads).toBe(1);
  expect(saves).toBe(0);
});

test('a stalled Save stays uncertain, a replay receipt becomes read-only recovery, and a late read cannot replace a later window', async () => {
  await withControlledTimeout(async (expire, delay) => {
    const firstSave = deferred<Awaited<ReturnType<CollectionPrivacyIO['save']>>>();
    const replayRead = deferred<CollectionPrivacyRead<OwnedCollection>>();
    const recovered = row('unlisted', 9);
    const late = row('private', 11);
    const commands: VisibilityAttempt[] = [];
    let reads = 0;
    const editor = new CollectionPrivacyEditor(initial, {
      save: async (input) => {
        commands.push(input);
        if (commands.length === 1) return firstSave.promise;
        return { ok: true, collection: receipt };
      },
      read: async (id) => {
        expect(id).toBe(initial.id);
        reads++;
        return reads === 1 ? replayRead.promise : { ok: true, value: recovered };
      },
    });
    const saving = editor.edit('public');
    await flushPromiseJobs();
    expect(delay()).toBe(managedReadTimeout);
    expire();
    await saving;
    const original = editor.snapshot().attempt!;
    expect(original).toEqual({
      collectionId: initial.id,
      revision: 7,
      visibility: 'public',
      idempotencyKey: expect.any(String),
    });
    expect(editor.snapshot()).toMatchObject({
      current: initial,
      desired: 'public',
      intent: 'public',
      phase: 'uncertain',
      attempt: original,
      outcomeUnknown: true,
    });
    expect(reads).toBe(0);
    firstSave.resolve({ ok: true, collection: receipt });
    await flushPromiseJobs();
    expect(editor.snapshot()).toMatchObject({ phase: 'uncertain', attempt: original, outcomeUnknown: true });
    expect(reads).toBe(0);
    expect(commands).toEqual([original]);

    const retry = editor.retry();
    await flushPromiseJobs();
    expect(commands).toEqual([original, original]);
    expect(commands[1]).toBe(original);
    expect(delay()).toBe(managedReadTimeout);
    expire();
    await retry;
    expect(editor.snapshot()).toMatchObject({
      phase: 'readback',
      attempt: original,
      receipt: { id: initial.id, revision: 8, visibility: 'public' },
      outcomeUnknown: false,
      desired: 'public',
    });
    expect(reads).toBe(1);

    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      current: recovered,
      desired: 'unlisted',
      intent: undefined,
      attempt: null,
      receipt: null,
      phase: 'saved',
    });
    replayRead.resolve({ ok: true, value: late });
    await flushPromiseJobs();
    expect(editor.snapshot()).toMatchObject({ current: recovered, desired: 'unlisted', attempt: null, phase: 'saved' });
    expect(commands).toEqual([original, original]);
    expect(reads).toBe(2);
  });
});

test('a stalled page keeps its window and cursor, and a late page cannot replace a later request', async () => {
  await withControlledTimeout(async (expire, delay) => {
    const nextPage = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
    const restartPage = deferred<CollectionPrivacyRead<{ collections: OwnedCollection[]; next: string | null }>>();
    const late = { ...row('public', 3), id: 'late-row', title: 'Late page' };
    const fresh = { ...row('unlisted', 4), title: 'Current reading' };
    const reads: (string | null)[] = [];
    const pager = new CollectionPrivacyPager(async (cursor) => {
      reads.push(cursor);
      if (reads.length === 1) return { ok: true, value: { collections: [initial], next: 'exact-next-page' } };
      if (reads.length === 2) return nextPage.promise;
      return restartPage.promise;
    });
    await pager.load();
    const loading = pager.load();
    await flushPromiseJobs();
    expect(delay()).toBe(managedReadTimeout);
    expire();
    await loading;
    expect(pager.snapshot()).toMatchObject({
      collections: [initial],
      next: 'exact-next-page',
      failure: 'unavailable',
      loading: false,
    });
    expect(pager.retryStartsAtFirstPage()).toBe(false);
    const retry = pager.load();
    await flushPromiseJobs();
    expect(reads).toEqual([null, 'exact-next-page', 'exact-next-page']);
    expire();
    await retry;
    expect(pager.snapshot()).toMatchObject({
      collections: [initial],
      next: 'exact-next-page',
      failure: 'unavailable',
      loading: false,
    });
    expect(pager.retryStartsAtFirstPage()).toBe(false);
    nextPage.resolve({ ok: true, value: { collections: [late], next: 'stale' } });
    await flushPromiseJobs();
    expect(pager.snapshot().collections).toEqual([initial]);
    const restart = pager.restart();
    await flushPromiseJobs();
    expect(reads).toEqual([null, 'exact-next-page', 'exact-next-page', null]);
    expect(pager.snapshot()).toMatchObject({ loading: true, restarting: true });
    expire();
    await restart;
    expect(pager.snapshot()).toMatchObject({
      collections: [initial],
      failure: 'unavailable',
      loading: false,
      restarting: false,
    });
    expect(pager.retryStartsAtFirstPage()).toBe(true);
    restartPage.resolve({ ok: true, value: { collections: [fresh], next: null } });
    await flushPromiseJobs();
    expect(pager.snapshot().collections).toEqual([initial]);
    const recovered = pager.restart();
    restartPage.resolve({ ok: true, value: { collections: [fresh], next: null } });
    await recovered;
    expect(reads.at(-1)).toBeNull();
    expect(pager.snapshot()).toMatchObject({ collections: [fresh], next: null, failure: null, loaded: true });
  });
});

test('a clean current read adopts native visibility without opening review', async () => {
  const current = row('unlisted', 12);
  const editor = new CollectionPrivacyEditor(initial, {
    save: async () => ({ ok: true, collection: receipt }),
    read: async () => ({ ok: true, value: current }),
  });
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({ current, desired: 'unlisted', intent: undefined, phase: 'idle' });
  expect(editor.needsListRestartProtection()).toBe(false);
});
