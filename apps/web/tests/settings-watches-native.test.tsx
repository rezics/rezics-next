import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { getLocale } from '../src/paraglide/runtime.js';
import { WatchController } from '../src/settings/watch-controller';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { decodeWatchPage, readWatchInventoryNative, removeWatchNative } = await import('../src/settings/watch-native');

const createdAt = '2026-11-03T10:00:00.000Z';
const threadRow = {
  id: 'thread-watch-episode',
  kind: 'thread',
  revision: 7,
  createdAt,
  state: 'available',
  resourceId: 'thread-1',
  title: 'Reading together',
  command: { watchId: 'thread-watch-episode', kind: 'thread', expectedRevision: 7 },
};
const unavailableRow = {
  id: 'private-watch-episode',
  kind: 'thread',
  revision: 9,
  createdAt,
  state: 'unavailable',
  command: { watchId: 'private-watch-episode', kind: 'thread', expectedRevision: 9 },
};
const envelope = {
  viewer: { state: 'current' as const, accountId: 'alice' },
  actions: { remove: 'available' as const },
};

test('watch pages strictly decode the installed kinds and conceal unavailable target identity', () => {
  const page = decodeWatchPage({ ...envelope, items: [threadRow, unavailableRow], next: null }, 'thread');
  expect(page.viewer).toEqual(envelope.viewer);
  expect(page.actions).toEqual(envelope.actions);
  expect(page.watches[0]).toMatchObject({
    subscriptionId: 'thread-watch-episode',
    kind: 'thread',
    revision: 7,
    command: threadRow.command,
    remove: 'available',
    target: { title: 'Reading together', href: `/${getLocale()}/threads/thread-1/reading-together` },
  });
  expect(page.watches[1]).toEqual({
    subscriptionId: 'private-watch-episode',
    kind: 'thread',
    revision: 9,
    createdAt,
    command: unavailableRow.command,
    remove: 'available',
    target: null,
  });
  expect(JSON.stringify(page.watches[1])).not.toContain('resourceId');
  expect(
    decodeWatchPage({ ...envelope, permissions: { remove: true }, items: [], next: null }, 'thread').watches,
  ).toEqual([]);
  expect(() => decodeWatchPage({ items: [{ ...threadRow, kind: 'unknown' }], next: null }, 'thread')).toThrow();
  expect(() =>
    decodeWatchPage({ ...envelope, items: [{ ...threadRow, extra: 'untrusted' }], next: null }, 'thread'),
  ).toThrow();
  expect(() =>
    decodeWatchPage({ ...envelope, actions: { remove: 'available', extra: true }, items: [], next: null }, 'thread'),
  ).toThrow();
});

test('generated inventory and exact removal operations preserve kind, cursor, revision and JSON key codec', async () => {
  const requests: { request: Request; body: unknown }[] = [];
  const client = createKernelClient('http://kernel.local', {
    headers: { authorization: 'Bearer alice' },
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === 'DELETE' ? await request.json() : undefined;
      requests.push({ request, body });
      if (request.method === 'GET') {
        const kind = url.searchParams.get('kind');
        return Response.json({
          ...envelope,
          items:
            kind === 'thread'
              ? [threadRow, unavailableRow]
              : [
                  {
                    id: 'board-watch-episode',
                    kind: 'board',
                    revision: 3,
                    createdAt,
                    state: 'available',
                    resourceId: 'board-1',
                    title: 'Books',
                    command: { watchId: 'board-watch-episode', kind: 'board', expectedRevision: 3 },
                  },
                ],
          next: null,
        });
      }
      return Response.json({ removed: true });
    }) as typeof fetch,
  });
  const first = await readWatchInventoryNative(client, 'alice', {
    kind: 'thread',
    limit: 20,
    cursor: null,
  });
  const board = await readWatchInventoryNative(client, 'alice', {
    kind: 'board',
    limit: 20,
    cursor: 'opaque/+cursor==',
  });
  expect(first.kind).toBe('page');
  expect(board.kind).toBe('page');
  if (first.kind !== 'page' || board.kind !== 'page') throw new Error('expected pages');
  expect(first.page.watches).toHaveLength(2);
  expect(board.page.watches[0]?.target?.href).toBe(`/${getLocale()}/boards/board-1`);
  expect(new URL(requests[0]!.request.url).searchParams.toString()).toBe('kind=thread&limit=20');
  expect(new URL(requests[1]!.request.url).searchParams.get('cursor')).toBe('opaque/+cursor==');
  expect(requests.slice(0, 2).map(({ request }) => request.headers.get('authorization'))).toEqual([
    'Bearer alice',
    'Bearer alice',
  ]);

  const command = Object.freeze({
    accountId: 'alice',
    watchId: 'private-watch-episode',
    kind: 'thread' as const,
    expectedRevision: 9,
    idempotencyKey: '01a17a3b-0884-721b-91ef-d7ffd7bb58f8',
  });
  expect(await removeWatchNative(client, command, 'Bearer alice')).toEqual({ kind: 'removed' });
  const deletion = requests[2]!;
  expect(deletion.request.method).toBe('DELETE');
  expect(new URL(deletion.request.url).pathname).toBe('/v1/accounts/alice/watches/private-watch-episode');
  expect(new URL(deletion.request.url).searchParams.get('kind')).toBe('thread');
  expect(deletion.request.headers.get('authorization')).toBe('Bearer alice');
  expect(deletion.request.headers.get('idempotency-key')).toBe(JSON.stringify(command.idempotencyKey));
  expect(deletion.body).toEqual({ expectedRevision: 9 });
});

test('caller authorization stays on the DELETE when factory defaults differ or are absent', async () => {
  const caller = 'Bearer caller-selected';
  const factoryDefault = 'Bearer factory-default';
  const command = Object.freeze({
    accountId: 'alice',
    watchId: 'private-watch-episode',
    kind: 'thread' as const,
    expectedRevision: 9,
    idempotencyKey: '01a17a3b-0884-721b-91ef-d7ffd7bb58f8',
  });
  const seen: { authorization: string | null; idempotency: string | null; method: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({
      authorization: request.headers.get('authorization'),
      idempotency: request.headers.get('idempotency-key'),
      method: request.method,
    });
    if (request.method === 'GET') return Response.json({ ...envelope, items: [unavailableRow], next: null });
    return Response.json({ removed: true });
  }) as typeof fetch;
  const factory = createKernelClient('http://kernel.local', { headers: { authorization: factoryDefault }, fetch });
  const injected = createKernelClient('http://kernel.local', { fetch });
  expect(await removeWatchNative(factory, command, caller)).toEqual({ kind: 'removed' });
  expect(await removeWatchNative(injected, command, caller)).toEqual({ kind: 'removed' });
  expect(seen.filter((entry) => entry.method === 'DELETE')).toEqual([
    { authorization: caller, idempotency: JSON.stringify(command.idempotencyKey), method: 'DELETE' },
    { authorization: caller, idempotency: JSON.stringify(command.idempotencyKey), method: 'DELETE' },
  ]);
  const listed = await readWatchInventoryNative(factory, 'alice', { kind: 'thread', limit: 20, cursor: null });
  expect(listed.kind).toBe('page');
  expect(seen.at(-1)).toMatchObject({ method: 'GET', authorization: factoryDefault, idempotency: null });
});

test('fixed 20-row watch visits release controllers and ignore unrelated inventory growth', async () => {
  const retainedSizes: number[] = [];
  for (const unrelated of [0, 10, 100]) {
    const serverRows = Array.from({ length: 20 + unrelated }, (_, index) => ({
      id: `watch-${index}`,
      kind: 'thread',
      revision: 1,
      createdAt,
      state: 'available',
      resourceId: `thread-${index}`,
      title: `Thread ${index}`,
      command: { watchId: `watch-${index}`, kind: 'thread', expectedRevision: 1 },
    }));
    const wire = JSON.stringify({ ...envelope, items: serverRows.slice(0, 20), next: null });
    for (const visits of [1, 10, 100]) {
      let requests = 0;
      let activeControllers = 0;
      let maxActiveControllers = 0;
      let commandAttempts = 0;
      let retainedRows = 0;
      let retainedBytes = 0;
      const client = createKernelClient('http://kernel.local', {
        fetch: (async () => {
          requests++;
          return new Response(wire, { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch,
      });
      for (let visit = 0; visit < visits; visit++) {
        const page = await readWatchInventoryNative(client, 'alice', {
          kind: 'thread',
          limit: 20,
          cursor: null,
        });
        const controller = new WatchController(
          {
            read: async () => page,
            stop: async () => {
              commandAttempts++;
              return { kind: 'removed' };
            },
          },
          { subject: 'alice', readCurrent: () => true, credential: () => 'csrf', subscribe: () => () => {} },
        );
        activeControllers++;
        maxActiveControllers = Math.max(maxActiveControllers, activeControllers);
        controller.mount();
        await controller.first();
        retainedRows = controller.snapshot().rows.length;
        retainedBytes = new TextEncoder().encode(JSON.stringify(controller.snapshot().rows)).byteLength;
        controller.retire();
        activeControllers--;
        expect(controller.snapshot().rows).toEqual([]);
      }
      expect(requests).toBe(visits);
      expect(activeControllers).toBe(0);
      expect(maxActiveControllers).toBe(1);
      expect(commandAttempts).toBe(0);
      expect(retainedRows).toBe(20);
      expect(retainedBytes).toBeLessThan(20_000);
      expect(new TextEncoder().encode(wire).byteLength * visits).toBeGreaterThan(0);
      retainedSizes.push(retainedBytes);
    }
  }
  expect(new Set(retainedSizes).size).toBe(1);
});

test('uncertain removal retries the original command and a retired owner callback cannot dispatch again', async () => {
  let current = true;
  let token = 'csrf';
  let notify!: () => void;
  const row = {
    subscriptionId: 'private-watch-episode',
    kind: 'thread' as const,
    revision: 9,
    createdAt,
    command: { watchId: 'private-watch-episode', kind: 'thread' as const, expectedRevision: 9 },
    remove: 'available' as const,
    target: null,
  };
  const listed = { kind: 'page' as const, page: { ...envelope, watches: [row], next: null } };
  const commands: unknown[] = [];
  const credentials: string[] = [];
  const controller = new WatchController(
    {
      read: async () => listed,
      stop: async (command, csrfToken) => {
        commands.push(command);
        credentials.push(csrfToken);
        return commands.length === 1
          ? { kind: 'uncertain' as const, problem: { status: 503, code: 'deadline_exceeded' } }
          : { kind: 'removed' as const };
      },
    },
    {
      subject: 'alice',
      readCurrent: () => current,
      credential: () => (current ? token : null),
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    },
  );
  controller.mount();
  await controller.first();
  await controller.stop(row.subscriptionId);
  const original = controller.snapshot().command;
  expect(original?.credential).toBe('csrf');
  expect(controller.snapshot().write).toBe('uncertain');
  await controller.refresh();
  expect(controller.snapshot().command).toBe(original);
  token = 'replacement';
  await controller.retryOriginal();
  expect(commands[0]).toBe(original);
  expect(commands[1]).toBe(original);
  expect(credentials).toEqual(['csrf', 'csrf']);
  expect(controller.snapshot()).toMatchObject({ write: 'removed', command: null, rows: [] });

  const lateController = new WatchController(
    {
      read: async () => listed,
      stop: async (command) => {
        commands.push(command);
        return { kind: 'removed' };
      },
    },
    {
      subject: 'alice',
      readCurrent: () => current,
      credential: () => (current ? 'csrf' : null),
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    },
  );
  current = true;
  lateController.mount();
  await lateController.first();
  current = false;
  notify();
  await lateController.stop(row.subscriptionId);
  expect(lateController.snapshot()).toMatchObject({ retired: true, rows: [], command: null });
  expect(commands).toHaveLength(2);
});

test('native inventory keeps problem metadata for cursor restart, dependency failure and conflicted removal', async () => {
  const answers = [
    Response.json({ code: 'invalid_cursor', retryable: false, request_id: 'cursor-1' }, { status: 400 }),
    Response.json({ code: 'dependency_unavailable', retryable: true, request_id: 'dep-1' }, { status: 503 }),
    Response.json({ code: 'conflict', retryable: false, request_id: 'rev-1' }, { status: 409 }),
  ];
  const client = createKernelClient('http://kernel.local', {
    headers: { authorization: 'Bearer alice' },
    fetch: (async () => answers.shift()!) as typeof fetch,
  });
  expect(await readWatchInventoryNative(client, 'alice', { kind: 'thread', limit: 20, cursor: 'stale' })).toEqual({
    kind: 'invalid_cursor',
    problem: { status: 400, code: 'invalid_cursor', retryable: false, requestId: 'cursor-1' },
  });
  expect(await readWatchInventoryNative(client, 'alice', { kind: 'thread', limit: 20, cursor: 'stale' })).toEqual({
    kind: 'unavailable',
    problem: { status: 503, code: 'dependency_unavailable', retryable: true, requestId: 'dep-1' },
  });
  expect(
    await removeWatchNative(
      client,
      {
        accountId: 'alice',
        watchId: 'private-watch-episode',
        kind: 'thread',
        expectedRevision: 9,
        idempotencyKey: '01a17a3b-0884-721b-91ef-d7ffd7bb58f8',
      },
      'Bearer alice',
    ),
  ).toEqual({ kind: 'conflict', problem: { status: 409, code: 'conflict', retryable: false, requestId: 'rev-1' } });
});
