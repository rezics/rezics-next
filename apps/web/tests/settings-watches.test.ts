import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../src/session/query';
import { SettingsSessionOwner } from '../src/settings/settings-session-owner';
import { WatchController, watchPageLimit } from '../src/settings/watch-controller';
import { unavailableWatchManagement, type ManagedWatch, type WatchManagementIO, type WatchRead, type StopWatch } from '../src/settings/watch-native';

const identity = { state: 'signed-in' as const, subject: 'alice', csrfToken: 'alice-token' };
const readable: ManagedWatch = { subscriptionId: 'owner-subscription', kind: 'thread', target: { title: 'Readable', href: '/threads/a/readable' } };
const inaccessible: ManagedWatch = { subscriptionId: 'owner-board-subscription', kind: 'board', target: null };
const page = (watches: readonly ManagedWatch[], next: string | null = null): WatchRead => ({ kind: 'page', page: { watches, next } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
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
  expect(controller.snapshot()).toMatchObject({ read: 'unavailable', rows: [] });
  const empty = setup({ read: async () => page([]), stop: async () => ({ kind: 'removed' }) }).controller;
  await empty.first();
  expect(empty.snapshot()).toMatchObject({ read: 'ready', rows: [], next: null });
});

test('sparse continuation uses the exact opaque cursor, fixed request size and one page in memory; failure retries that page', async () => {
  const cursors: (string | null)[] = [];
  let fail = false;
  const opaque = ' sealed/+cursor== ';
  const { controller } = setup({
    read: async ({ cursor, limit }) => {
      expect(limit).toBe(watchPageLimit);
      cursors.push(cursor);
      if (fail) { fail = false; throw new Error('read failed'); }
      return cursor === null ? page([], opaque) : page([readable]);
    }, stop: async () => ({ kind: 'removed' }),
  });
  await controller.first();
  expect(controller.snapshot()).toMatchObject({ rows: [], next: opaque });
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
    read: async () => { if (fail) throw new Error('offline'); return result; },
    stop: async () => { writes++; return { kind: 'removed' }; },
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
  const { controller } = setup({ read: async () => page([inaccessible, readable]), stop: async (input, token) => {
    expect(token).toBe(identity.csrfToken);
    commands.push(input);
    return { kind: 'removed' };
  } });
  await controller.first();
  await controller.stop(inaccessible.subscriptionId);
  expect(commands[0]?.subscriptionId).toBe(inaccessible.subscriptionId);
  expect(Object.isFrozen(commands[0])).toBe(true);
  expect(controller.snapshot()).toMatchObject({ write: 'removed', rows: [readable], command: null });
});

test('unknown stop preserves the immutable original through list refresh; only explicit retry sends it again', async () => {
  const commands: StopWatch[] = [];
  let current = page([readable, inaccessible]);
  const { controller } = setup({ read: async () => current, stop: async (input) => {
    commands.push(input);
    if (commands.length === 1) throw new Error('reply lost');
    return { kind: 'removed' };
  } });
  await controller.first();
  await controller.stop(readable.subscriptionId);
  const original = controller.snapshot().command;
  expect(controller.needsDecision()).toBe(true);
  current = page([]);
  await controller.refresh();
  await controller.stop(inaccessible.subscriptionId);
  expect(controller.snapshot()).toMatchObject({ write: 'uncertain', command: original });
  expect(commands).toHaveLength(1);
  await controller.retryOriginal();
  expect(commands[1]).toBe(original);
  expect(controller.snapshot()).toMatchObject({ write: 'removed', command: null });
  expect(controller.needsDecision()).toBe(false);
});

test('viewer replacement or failed session refresh retires rows, pending commands and saved callbacks before late results', async () => {
  for (const transition of ['replacement', 'error'] as const) {
    const lateRead = deferred<WatchRead>();
    const lateCommand = deferred<{ kind: 'removed' }>();
    let writes = 0;
    const { controller, client } = setup({
      read: async () => page([readable]),
      stop: async () => { writes++; return lateCommand.promise; },
    });
    await controller.first();
    const write = controller.stop(readable.subscriptionId);
    if (transition === 'replacement') client.setQueryData(sessionQuery.queryKey, { ...identity, subject: 'bob' });
    else client.getQueryCache().find({ queryKey: sessionQuery.queryKey })!.setState({ status: 'error' });
    lateCommand.resolve({ kind: 'removed' });
    await write;
    await controller.retryOriginal();
    await controller.stop(readable.subscriptionId);
    expect(writes).toBe(1);
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
