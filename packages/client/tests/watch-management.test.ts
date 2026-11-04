import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  type KernelClient,
  type WatchManagementItem,
  type WatchManagementKind,
  type WatchManagementPage,
} from '../src/index.ts';

type Inventory = ReturnType<KernelClient['accounts']>['watches'];
expectTypeOf<Awaited<ReturnType<Inventory['get']>>['data']>().toEqualTypeOf<WatchManagementPage | null>();
expectTypeOf<WatchManagementPage['items'][number]>().toEqualTypeOf<WatchManagementItem>();
expectTypeOf<WatchManagementKind>().toEqualTypeOf<'thread' | 'board'>();
expectTypeOf<WatchManagementPage['viewer']['state']>().toEqualTypeOf<'current'>();
expectTypeOf<WatchManagementPage['actions']['remove']>().toEqualTypeOf<'available' | 'denied'>();

test('generated mounted inventory keeps bounded closed disclosure variants', async () => {
  const contract = await Bun.file(new URL('../../../contracts/openapi.json', import.meta.url)).json();
  const page =
    contract.paths['/v1/accounts/{accountId}/watches'].get.responses['200'].content['application/json'].schema;
  expect(page.additionalProperties).toBe(false);
  expect(page.required.slice().sort()).toEqual(['actions', 'items', 'next', 'viewer']);
  expect(page.properties.items.maxItems).toBe(20);
  expect(page.properties.viewer.properties.state.const).toBe('current');
  expect(page.properties.actions.properties.remove.enum).toEqual(['available', 'denied']);
  const variants = page.properties.items.items.anyOf;
  expect(variants).toHaveLength(2);
  for (const variant of variants) {
    expect(variant.additionalProperties).toBe(false);
    expect(variant.properties.revision.minimum).toBe(1);
    expect(variant.properties.createdAt.format).toBe('date-time');
    expect(variant.properties.id.pattern).toBeString();
    expect(Object.keys(variant.properties.command.properties).sort()).toEqual([
      'expectedRevision',
      'kind',
      'watchId',
    ]);
  }
  expect(Object.keys(variants[1].properties).sort()).toEqual([
    'command',
    'createdAt',
    'id',
    'kind',
    'revision',
    'state',
  ]);
});

test('installed watch inventory preserves sparse cursors, unavailable retry and private removal metadata', async () => {
  const accountId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const watchId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const resourceId = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const identity = {
    id: watchId,
    kind: 'thread' as const,
    revision: 1,
    createdAt: '2026-11-04T00:00:00.000Z',
    command: { watchId, kind: 'thread' as const, expectedRevision: 1 },
  };
  const envelope = {
    viewer: { state: 'current' as const, accountId },
    actions: { remove: 'available' as const },
  };
  const pages: WatchManagementPage[] = [
    { ...envelope, items: [], next: 'opaque+/cursor=' },
    { ...envelope, items: [{ ...identity, state: 'available', resourceId, title: 'Watched thread' }], next: 'next' },
    { ...envelope, items: [{ ...identity, state: 'unavailable' }], next: null },
  ];
  const answers = [
    Response.json(pages[0]),
    Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
    Response.json(pages[1]),
    Response.json(pages[2]),
    Response.json({ removed: true }),
  ];
  const sent: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      sent.push(new Request(input, init));
      return answers.shift()!;
    }) as typeof fetch,
  });
  const inventory = client.accounts({ accountId }).watches;
  const query = { kind: 'thread' as const, limit: 1 };
  expect((await inventory.get({ query })).data).toEqual(pages[0]!);
  const resumed = { query: { ...query, cursor: pages[0]!.next! } };
  expect((await inventory.get(resumed)).status).toBe(503);
  expect((await inventory.get(resumed)).data).toEqual(pages[1]!);
  expect(sent[1]!.url).toBe(sent[2]!.url);
  expect(new URL(sent[2]!.url).searchParams.get('cursor')).toBe(pages[0]!.next);
  expect((await inventory.get({ query: { ...query, cursor: 'next' } })).data).toEqual(pages[2]!);
  expect(
    (
      await inventory({ watchId }).delete(
        { expectedRevision: 1 },
        {
          query: { kind: 'thread' },
          headers: { 'idempotency-key': 'remove-key' },
        },
      )
    ).data,
  ).toEqual({ removed: true });
  const removed = sent[4]!;
  expect(removed.method).toBe('DELETE');
  expect(new URL(removed.url).pathname).toBe(`/v1/accounts/${accountId}/watches/${watchId}`);
  expect(new URL(removed.url).searchParams.get('kind')).toBe('thread');
  expect(removed.headers.get('idempotency-key')).toBe('remove-key');
  expect(await removed.json()).toEqual({ expectedRevision: 1 });
});

test('installed client default authorization remains on the typed watch wire', async () => {
  const accountId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const watchId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const sent: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    headers: { authorization: 'Bearer owner-token' },
    fetch: (async (input, init) => {
      sent.push(new Request(input, init));
      if (sent.length === 1)
        return Response.json({
          viewer: { state: 'current', accountId },
          actions: { remove: 'available' },
          items: [],
          next: null,
        });
      return Response.json({ removed: true });
    }) as typeof fetch,
  });
  const inventory = client.accounts({ accountId }).watches;
  expect((await inventory.get({ query: { kind: 'thread', limit: 20 } })).status).toBe(200);
  expect(
    (
      await inventory({ watchId }).delete(
        { expectedRevision: 1 },
        { query: { kind: 'thread' }, headers: { 'idempotency-key': '"retry-key"' } },
      )
    ).status,
  ).toBe(200);
  expect(sent.map((request) => request.headers.get('authorization'))).toEqual(['Bearer owner-token', 'Bearer owner-token']);
  expect(sent[1]!.headers.get('idempotency-key')).toBe('"retry-key"');
});
