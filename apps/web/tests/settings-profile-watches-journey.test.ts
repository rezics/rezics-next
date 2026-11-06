import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../src/session/query';
import { SettingsSessionOwner } from '../src/settings/settings-session-owner';
import { WatchController, watchPageLimit, watchPreviousLimit } from '../src/settings/watch-controller';
import {
  type ManagedWatch,
  type StopWatch,
  type WatchKind,
  type WatchManagementIO,
  type WatchRead,
} from '../src/settings/watch-native';
import { ProfileEditor } from '../src/settings/profile-write';
import { captureProfileReturn } from '../src/settings/settings-return';
import { editableProfile, profileValues } from './factories/profile';

const identity = { state: 'signed-in' as const, subject: 'alice', csrfToken: 'alice-token' };
const viewer = { state: 'current' as const, accountId: 'alice' };
const actions = { remove: 'available' as const };

function managed(
  row: Omit<ManagedWatch, 'command' | 'remove'> & Partial<Pick<ManagedWatch, 'command' | 'remove'>>,
): ManagedWatch {
  return {
    ...row,
    command: row.command ?? { watchId: row.subscriptionId, kind: row.kind, expectedRevision: row.revision },
    remove: row.remove ?? 'available',
  };
}

const thread = managed({
  subscriptionId: 'thread-subscription',
  kind: 'thread',
  revision: 4,
  createdAt: '2026-11-03T10:00:00.000Z',
  target: { title: 'Readable thread', href: '/threads/a/readable' },
});
const withheldBoard = managed({
  subscriptionId: 'board-subscription',
  kind: 'board',
  revision: 5,
  createdAt: '2026-11-03T09:00:00.000Z',
  target: null,
});
const laterThread = managed({ ...thread, revision: 6, target: { title: 'Newer episode', href: '/threads/a/readable' } });

function page(kind: WatchKind, watches: readonly ManagedWatch[], next: string | null = null): WatchRead {
  return { kind: 'page', page: { viewer, actions, watches: watches.filter((row) => row.kind === kind), next } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function setup(io: WatchManagementIO) {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, identity);
  const owner = new SettingsSessionOwner(client, identity.csrfToken, identity.subject);
  owner.mount();
  const controller = new WatchController(io, owner);
  controller.mount();
  return { client, owner, controller };
}

test('Profile save, unsaved draft, both Watch kinds, withheld target, original removal and return restore the draft', async () => {
  const known = profileValues(editableProfile({ displayName: 'Saved name', bio: 'Saved notes' }));
  let current = known;
  const reads: string[] = [];
  const writes: object[] = [];
  const editor = new ProfileEditor({
    read: async () => {
      reads.push(current.accountId);
      return current;
    },
    save: async (attempt) => {
      writes.push(attempt.patch);
      current = attempt.after;
      return { ok: true, profile: attempt.after };
    },
  });
  await editor.reload();
  editor.edit({ displayName: 'Saved name', biography: 'Saved notes' });
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('saved');
  expect(writes).toEqual([{ displayName: 'Saved name', biography: 'Saved notes' }]);
  expect(reads).toEqual([known.accountId, known.accountId]);

  editor.edit({ biography: 'Later unsaved notes' });
  editor.lastFocus = 'biography';
  const snapshot = captureProfileReturn(editor.snapshot().known, editor.snapshot().draft, editor.lastFocus);
  expect(snapshot?.draft.biography).toBe('Later unsaved notes');

  const commands: StopWatch[] = [];
  let boardRows: readonly ManagedWatch[] = [withheldBoard];
  const { controller, owner } = setup({
    read: async ({ kind, limit }) => {
      expect(limit).toBe(watchPageLimit);
      return kind === 'thread' ? page('thread', [thread]) : page('board', boardRows);
    },
    stop: async (command) => {
      commands.push(command);
      return commands.length === 1
        ? { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded' } }
        : { kind: 'removed' };
    },
  });
  await controller.first();
  expect(controller.snapshot().rows).toEqual([thread]);
  expect(controller.captureReturn(thread.subscriptionId, true)).toMatchObject({
    identity: { subscriptionId: thread.subscriptionId, kind: 'thread', revision: 4 },
    focusRequested: true,
  });
  await controller.selectKind('board');
  expect(controller.snapshot().rows).toEqual([withheldBoard]);
  expect(controller.captureReturn(withheldBoard.subscriptionId, false)).toBeNull();
  await controller.stop(withheldBoard.subscriptionId);
  const original = controller.snapshot().command!;
  expect(original).toMatchObject({
    watchId: withheldBoard.subscriptionId,
    kind: 'board',
    expectedRevision: 5,
    credential: identity.csrfToken,
  });
  boardRows = [managed({ ...withheldBoard, revision: 9 })];
  await controller.refresh();
  expect(controller.snapshot().rows[0]?.revision).toBe(9);
  expect(controller.snapshot().command).toBe(original);
  await controller.retryOriginal();
  expect(commands[1]).toBe(original);
  expect(controller.snapshot()).toMatchObject({ write: 'removed_current', command: null });

  current = { ...current, displayName: 'Native later name' };
  editor.receive(current);
  editor.restoreReturn(snapshot!);
  expect(editor.snapshot().draft?.displayName).toBe('Native later name');
  expect(editor.snapshot().draft?.biography).toBe('Later unsaved notes');
  expect(editor.pendingReturnFocus).toBe('biography');
  owner.retire();
  expect(controller.snapshot().retired).toBe(true);
});

test('keyboard return restores only the exact current Watch; a missing row is missing without scanning', async () => {
  const current = managed({
    subscriptionId: 'current-window',
    kind: 'thread',
    revision: 7,
    createdAt: '2026-11-03T10:00:00.000Z',
    target: { title: 'Current', href: '/threads/a/current' },
  });
  const neighbour = managed({
    subscriptionId: 'neighbour',
    kind: 'thread',
    revision: 8,
    createdAt: '2026-11-03T10:00:00.000Z',
    target: { title: 'Neighbour', href: '/threads/a/neighbour' },
  });
  const { controller } = setup({
    read: async ({ cursor }) => page('thread', cursor === 'later' ? [current, neighbour] : [neighbour]),
    stop: async () => ({ kind: 'removed' }),
  });
  await controller.first();
  await controller.returnTo({
    locator: { current: { kind: 'thread', cursor: 'later' }, previous: [{ kind: 'thread', cursor: null }] },
    identity: { subscriptionId: current.subscriptionId, kind: 'thread', revision: 7 },
    focusRequested: true,
  });
  expect(controller.snapshot()).toMatchObject({
    returnOutcome: 'restored',
    cursor: 'later',
    previous: [{ kind: 'thread', cursor: null }],
    returnFocus: { focusRequested: true, outcome: 'restored' },
  });
  await controller.returnTo({
    locator: { current: { kind: 'thread', cursor: 'later' }, previous: [{ kind: 'thread', cursor: null }] },
    identity: { subscriptionId: 'absent', kind: 'thread', revision: 1 },
    focusRequested: true,
  });
  expect(controller.snapshot().returnOutcome).toBe('missing');
  expect(controller.snapshot().rows.map((row) => row.subscriptionId)).toEqual(['current-window', 'neighbour']);
});

test('available, denied and unavailable Watch admission stay distinct; session replacement retires callbacks', async () => {
  for (const read of [
    { kind: 'page' as const, page: { viewer, actions: { remove: 'denied' as const }, watches: [thread], next: null } },
    { kind: 'denied' as const, problem: { status: 403, code: 'forbidden' } },
    { kind: 'unavailable' as const, problem: { status: 503, code: 'dependency_unavailable' } },
  ]) {
    const { controller } = setup({
      read: async () => read,
      stop: async () => ({ kind: 'removed' }),
    });
    await controller.first();
    if (read.kind === 'page') {
      expect(controller.snapshot()).toMatchObject({ read: 'ready', actions: { remove: 'denied' }, rows: [thread] });
      await controller.stop(thread.subscriptionId);
      expect(controller.snapshot().command).toBeNull();
    } else expect(controller.snapshot().read).toBe(read.kind);
  }
  let writes = 0;
  const late = deferred<{ kind: 'removed' }>();
  const { client, controller } = setup({
    read: async () => page('thread', [thread]),
    stop: async () => {
      writes++;
      return late.promise;
    },
  });
  await controller.first();
  const stopping = controller.stop(thread.subscriptionId);
  client.setQueryData(sessionQuery.queryKey, { ...identity, subject: 'bob', csrfToken: 'bob-token' });
  late.resolve({ kind: 'removed' });
  await stopping;
  await controller.retryOriginal();
  expect(writes).toBe(1);
  expect(controller.snapshot().retired).toBe(true);
});

test('a receipt then failed Profile readback keeps acknowledgement; sequential Watch visits keep one 20-row window', async () => {
  let reads = 0;
  const editor = new ProfileEditor(
    {
      save: async (attempt) => ({ ok: true, profile: attempt.after }),
      read: async () => {
        reads++;
        throw new Error('Read unavailable');
      },
    },
    profileValues(editableProfile()),
  );
  editor.edit({ displayName: 'Submitted' });
  await editor.submit('profile');
  expect(editor.snapshot()).toMatchObject({ acknowledged: true, phase: 'uncertain', attempt: expect.anything() });
  expect(reads).toBe(1);
  await editor.retry();
  expect(reads).toBe(1);

  const visits = [1, 10, 100];
  const retained: number[] = [];
  for (const count of visits) {
    let requests = 0;
    const rows = Array.from({ length: 20 }, (_, index) =>
      managed({
        subscriptionId: `watch-${index}`,
        kind: 'thread',
        revision: 1,
        createdAt: '2026-11-03T10:00:00.000Z',
        target: { title: `Thread ${index}`, href: `/threads/a/${index}` },
      }),
    );
    for (let visit = 0; visit < count; visit++) {
      const { controller } = setup({
        read: async ({ limit }) => {
          requests++;
          expect(limit).toBe(watchPageLimit);
          return page('thread', rows, 'next-cursor');
        },
        stop: async () => ({ kind: 'removed' }),
      });
      await controller.first();
      expect(controller.snapshot().rows).toHaveLength(20);
      expect(controller.snapshot().previous).toHaveLength(0);
      for (let step = 0; step < watchPreviousLimit + 2; step++) {
        await controller.next();
      }
      expect(controller.snapshot().previous.length).toBeLessThanOrEqual(watchPreviousLimit);
      controller.retire();
      expect(controller.snapshot().rows).toEqual([]);
    }
    retained.push(requests);
    expect(requests).toBe(count * (1 + watchPreviousLimit + 2));
  }
  expect(retained[0]).toBe(1 + watchPreviousLimit + 2);
});
