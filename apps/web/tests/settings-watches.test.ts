import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../src/session/query';
import { SettingsSessionOwner } from '../src/settings/settings-session-owner';
import { WatchController, watchPageLimit } from '../src/settings/watch-controller';
import {
  unavailableWatchManagement,
  type ManagedWatch,
  type WatchManagementIO,
  type WatchRead,
  type StopWatch,
} from '../src/settings/watch-native';

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
const readable = managed({
  subscriptionId: 'owner-subscription',
  kind: 'thread',
  revision: 3,
  createdAt: '2026-11-03T10:00:00.000Z',
  target: { title: 'Readable', href: '/threads/a/readable' },
});
const inaccessible = managed({
  subscriptionId: 'owner-private-subscription',
  kind: 'thread',
  revision: 4,
  createdAt: '2026-11-02T10:00:00.000Z',
  target: null,
});
const page = (watches: readonly ManagedWatch[], next: string | null = null): WatchRead => ({
  kind: 'page',
  page: { viewer, actions, watches, next },
});
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

test('unavailable management stays distinct from an actual empty page', async () => {
  const { controller } = setup(unavailableWatchManagement);
  await controller.first();
  expect(controller.snapshot()).toMatchObject({
    read: 'unavailable',
    rows: [],
    readProblem: { status: null, code: null },
  });
  const empty = setup({ read: async () => page([]), stop: async () => ({ kind: 'removed' }) }).controller;
  await empty.first();
  expect(empty.snapshot()).toMatchObject({ read: 'ready', rows: [], next: null, actions: { remove: 'available' } });
});

test('sparse continuation uses the exact opaque cursor, fixed request size and one page in memory; failure retries that page', async () => {
  const cursors: (string | null)[] = [];
  let fail = false;
  const opaque = ' sealed/+cursor== ';
  const { controller } = setup({
    read: async ({ cursor, limit }) => {
      expect(limit).toBe(watchPageLimit);
      cursors.push(cursor);
      if (fail) {
        fail = false;
        throw new Error('read failed');
      }
      return cursor === null ? page([], opaque) : page([readable]);
    },
    stop: async () => ({ kind: 'removed' }),
  });
  await controller.first();
  expect(controller.snapshot()).toMatchObject({ rows: [], next: opaque, viewer });
  fail = true;
  await controller.next();
  expect(controller.snapshot()).toMatchObject({ read: 'failed', rows: [], cursor: opaque });
  await controller.refresh();
  expect(controller.snapshot()).toMatchObject({ rows: [readable], next: null });
  expect(cursors).toEqual([null, opaque, opaque]);
  await controller.first();
  expect(controller.snapshot().rows).toEqual([]);
});

test('failed refresh withdraws old rows and their write authority; oversized owner pages fail closed', async () => {
  let result = page([readable]);
  let fail = false;
  let writes = 0;
  const { controller } = setup({
    read: async () => {
      if (fail) throw new Error('offline');
      return result;
    },
    stop: async () => {
      writes++;
      return { kind: 'removed' };
    },
  });
  await controller.first();
  fail = true;
  await controller.refresh();
  await controller.stop(readable.subscriptionId);
  expect(writes).toBe(0);
  expect(controller.snapshot()).toMatchObject({ read: 'failed', rows: [] });
  fail = false;
  result = page(Array.from({ length: watchPageLimit + 1 }, (_, n) => ({ ...readable, subscriptionId: `${n}` })));
  await controller.refresh();
  expect(controller.snapshot().read).toBe('failed');
});

test('lost target access still permits removal by owner subscription identity, with the installed CSRF credential', async () => {
  const commands: StopWatch[] = [];
  const { controller } = setup({
    read: async () => page([inaccessible, readable]),
    stop: async (input, token) => {
      expect(token).toBe(identity.csrfToken);
      commands.push(input);
      return { kind: 'removed' };
    },
  });
  await controller.first();
  await controller.stop(inaccessible.subscriptionId);
  expect(commands[0]?.watchId).toBe(inaccessible.command.watchId);
  expect(commands[0]).toMatchObject({
    accountId: 'alice',
    kind: 'thread',
    expectedRevision: inaccessible.command.expectedRevision,
  });
  expect(Object.isFrozen(commands[0])).toBe(true);
  expect(controller.snapshot()).toMatchObject({ write: 'removed', rows: [readable], command: null });
});

test('uncertain removal needs current advice and both captured retry deadlines before replaying its original', async () => {
  const startedAt = Date.parse('2026-11-05T10:00:00.000Z');
  const realNow = Date.now;
  let now = startedAt;
  Date.now = () => now;
  const commands: StopWatch[] = [];
  const credentials: string[] = [];
  const cursors: (string | null)[] = [];
  const nextCursor = 'sealed/+cursor==';
  let current: WatchRead = page([readable, inaccessible], nextCursor);
  const revised = (revision: number, remove: 'available' | 'denied' = 'available') =>
    managed({
      ...readable,
      revision,
      command: { ...readable.command, expectedRevision: revision },
      remove,
    });
  const { client, controller } = setup({
    read: async ({ cursor }) => {
      cursors.push(cursor);
      return current;
    },
    stop: async (input, token) => {
      commands.push(input);
      credentials.push(token);
      return commands.length === 1
        ? { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded', retryAfter: '5' } }
        : { kind: 'removed' };
    },
  });
  try {
    await controller.first();
    await controller.stop(readable.subscriptionId);
    const original = controller.snapshot().command;
    expect(original?.credential).toBe(identity.csrfToken);
    expect(controller.snapshot()).toMatchObject({ write: 'uncertain', writeRetryAt: startedAt + 5000 });
    expect(controller.needsDecision()).toBe(true);
    expect(controller.canRetryOriginal()).toBe(false);

    current = { kind: 'denied', problem: { status: 410, code: 'closed', retryAfter: '2' } };
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ read: 'denied', command: original, readRetryAt: startedAt + 2000 });
    expect(controller.canRetryOriginal()).toBe(false);
    await controller.refresh();
    await controller.retryOriginal();
    expect(cursors).toEqual([null, null]);
    expect(commands).toHaveLength(1);

    now += 2000;
    current = {
      kind: 'page',
      page: { viewer, actions: { remove: 'denied' }, watches: [revised(4, 'denied')], next: nextCursor },
    };
    await controller.refresh();
    expect(controller.snapshot().command).toBe(original);
    expect(controller.canRetryOriginal()).toBe(false);

    current = page([revised(5)], nextCursor);
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      command: original,
      actions: { remove: 'available' },
      writeRetryAt: startedAt + 5000,
    });
    expect(controller.canRetryOriginal()).toBe(false);
    current = page([]);
    await controller.next();
    expect(controller.snapshot()).toMatchObject({ command: original, rows: [] });
    expect(controller.canRetryOriginal()).toBe(false);

    now += 3000;
    expect(controller.canRetryOriginal()).toBe(true);
    await controller.retryOriginal();
    expect(commands[1]).toBe(original);
    expect(credentials).toEqual([identity.csrfToken, identity.csrfToken]);
    expect(controller.snapshot()).toMatchObject({ write: 'removed', command: null });
    expect(controller.needsDecision()).toBe(false);
    expect(cursors).toEqual([null, null, null, null, nextCursor]);
  } finally {
    Date.now = realNow;
    client.clear();
  }
});

test('viewer replacement or failed session refresh retires rows, pending commands and saved callbacks before late results', async () => {
  for (const transition of ['replacement', 'error'] as const) {
    const lateRead = deferred<WatchRead>();
    const lateCommand = deferred<{ kind: 'removed' }>();
    const credentials: string[] = [];
    let writes = 0;
    const { controller, client } = setup({
      read: async () => page([readable]),
      stop: async (_input, token) => {
        writes++;
        credentials.push(token);
        return lateCommand.promise;
      },
    });
    await controller.first();
    const write = controller.stop(readable.subscriptionId);
    if (transition === 'replacement')
      client.setQueryData(sessionQuery.queryKey, { ...identity, subject: 'bob', csrfToken: 'bob-token' });
    else client.getQueryCache().find({ queryKey: sessionQuery.queryKey })!.setState({ status: 'error' });
    lateCommand.resolve({ kind: 'removed' });
    await write;
    await controller.retryOriginal();
    await controller.stop(readable.subscriptionId);
    expect(writes).toBe(1);
    expect(credentials).toEqual([identity.csrfToken]);
    expect(controller.snapshot()).toMatchObject({ retired: true, rows: [], command: null });
    // A separate still-mounted observation also rejects reads arriving after a subject transition.
    const next = setup({ read: async () => lateRead.promise, stop: async () => ({ kind: 'removed' }) });
    const read = next.controller.first();
    next.client.setQueryData(sessionQuery.queryKey, { ...identity, subject: 'bob' });
    lateRead.resolve(page([readable]));
    await read;
    expect(next.controller.snapshot()).toMatchObject({ retired: true, rows: [] });
  }
});

test('invalid cursors offer a cursor-free restart; transient failures retry the same range', async () => {
  const cursors: (string | null)[] = [];
  let mode: 'page' | 'invalid' | 'unavailable' = 'page';
  const opaque = 'sealed/+cursor==';
  const { controller } = setup({
    read: async ({ cursor }) => {
      cursors.push(cursor);
      if (mode === 'invalid') return { kind: 'invalid_cursor', problem: { status: 400, code: 'invalid_cursor' } };
      if (mode === 'unavailable')
        return { kind: 'unavailable', problem: { status: 503, code: 'dependency_unavailable' } };
      return cursor === null ? page([], opaque) : page([readable]);
    },
    stop: async () => ({ kind: 'removed' }),
  });
  await controller.first();
  mode = 'unavailable';
  await controller.next();
  expect(controller.snapshot()).toMatchObject({
    read: 'unavailable',
    cursor: opaque,
    readProblem: { status: 503, code: 'dependency_unavailable' },
  });
  mode = 'page';
  await controller.refresh();
  expect(controller.snapshot()).toMatchObject({ read: 'ready', rows: [readable] });
  mode = 'invalid';
  await controller.refresh();
  expect(controller.snapshot()).toMatchObject({ read: 'invalid_cursor', cursor: opaque });
  mode = 'page';
  await controller.first();
  expect(controller.snapshot()).toMatchObject({ read: 'ready', rows: [] });
  expect(cursors).toEqual([null, opaque, opaque, opaque, null]);
});

test('owner-denied remove advice keeps concealed rows and withholds the stop command', async () => {
  const denied = managed({ ...inaccessible, remove: 'denied' });
  let writes = 0;
  const { controller } = setup({
    read: async () => ({
      kind: 'page',
      page: { viewer, actions: { remove: 'denied' }, watches: [denied], next: null },
    }),
    stop: async () => {
      writes++;
      return { kind: 'removed' };
    },
  });
  await controller.first();
  await controller.stop(denied.subscriptionId);
  expect(writes).toBe(0);
  expect(controller.snapshot()).toMatchObject({
    read: 'ready',
    actions: { remove: 'denied' },
    rows: [denied],
    command: null,
  });
});

test('a confirmed original board stop preserves a refreshed revision and keeps read feedback separate', async () => {
  const boardAt = (revision: number, target: ManagedWatch['target']) =>
    managed({
      subscriptionId: 'board-subscription',
      kind: 'board',
      revision,
      createdAt: '2026-11-03T10:00:00.000Z',
      target,
    });
  const originalRow = boardAt(11, null);
  const currentRow = boardAt(13, { title: 'Current board', href: '/boards/current' });
  let result: WatchRead = page([originalRow]);
  const commands: StopWatch[] = [];
  const { controller } = setup({
    read: async () => result,
    stop: async (command) => {
      commands.push(command);
      return commands.length === 1
        ? { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded' } }
        : { kind: 'removed' };
    },
  });

  await controller.selectKind('board');
  await controller.stop(originalRow.subscriptionId);
  const original = controller.snapshot().command!;
  result = { kind: 'unavailable', problem: { status: 502, code: 'inventory_unavailable' } };
  await controller.refresh();
  expect(controller.snapshot()).toMatchObject({
    read: 'unavailable',
    readProblem: { code: 'inventory_unavailable' },
    write: 'uncertain',
    writeProblem: { code: 'deadline_exceeded' },
    command: original,
  });

  result = page([currentRow]);
  await controller.refresh();
  expect(controller.snapshot()).toMatchObject({
    read: 'ready',
    readProblem: null,
    write: 'uncertain',
    writeProblem: { code: 'deadline_exceeded' },
    command: original,
    rows: [currentRow],
  });
  await controller.retryOriginal();
  expect(commands[1]).toBe(original);
  expect(controller.snapshot()).toMatchObject({
    write: 'removed_current',
    command: null,
    writeProblem: null,
    rows: [currentRow],
    viewer,
    actions,
  });

  await controller.stop(currentRow.subscriptionId);
  expect(commands[2]).toMatchObject({ watchId: 'board-subscription', kind: 'board', expectedRevision: 13 });
  expect(commands[2]?.idempotencyKey).not.toBe(original.idempotencyKey);
  expect(controller.snapshot()).toMatchObject({ write: 'removed', rows: [], command: null });
});

test('conflict and access-denied stops do not replay the original command', async () => {
  const commands: StopWatch[] = [];
  let outcome: 'conflict' | 'denied' = 'conflict';
  const { controller } = setup({
    read: async () => page([readable]),
    stop: async (input) => {
      commands.push(input);
      return outcome === 'conflict'
        ? { kind: 'conflict', problem: { status: 409, code: 'conflict' } }
        : { kind: 'denied', problem: { status: 403, code: 'forbidden' } };
    },
  });
  await controller.first();
  await controller.stop(readable.subscriptionId);
  expect(controller.snapshot()).toMatchObject({ write: 'conflict', command: null, read: 'failed' });
  await controller.retryOriginal();
  expect(commands).toHaveLength(1);
  await controller.first();
  outcome = 'denied';
  await controller.stop(readable.subscriptionId);
  expect(controller.snapshot()).toMatchObject({ write: 'denied', command: null, read: 'denied' });
  await controller.retryOriginal();
  expect(commands).toHaveLength(2);
});
