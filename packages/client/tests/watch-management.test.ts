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
expectTypeOf<Extract<WatchManagementItem, { state: 'available' }>>().toEqualTypeOf<{
  id: string;
  kind: WatchManagementKind;
  revision: number;
  createdAt: string;
  state: 'available';
  resourceId: string;
  title: string | null;
}>();
expectTypeOf<Extract<WatchManagementItem, { state: 'unavailable' }>>().toEqualTypeOf<{
  id: string;
  kind: WatchManagementKind;
  revision: number;
  createdAt: string;
  state: 'unavailable';
}>();
type BoardWatch = ReturnType<KernelClient['boards']>['watch'];
expectTypeOf<Awaited<ReturnType<BoardWatch['get']>>['data']>().toMatchTypeOf<
  { watching: boolean; revision: number } | null
>();
expectTypeOf<Parameters<BoardWatch['put']>[0]>().toMatchTypeOf<{
  watching: boolean;
  expectedRevision: number;
}>();

test('generated mounted inventory keeps bounded closed disclosure variants', async () => {
  const contract = await Bun.file(new URL('../../../contracts/openapi.json', import.meta.url)).json();
  const page =
    contract.paths['/v1/accounts/{accountId}/watches'].get.responses['200'].content['application/json'].schema;
  expect(page.additionalProperties).toBe(false);
  expect(page.properties.items.maxItems).toBe(20);
  const variants = page.properties.items.items.anyOf;
  expect(variants).toHaveLength(2);
  for (const variant of variants) {
    expect(variant.additionalProperties).toBe(false);
    expect(variant.properties.revision.minimum).toBe(1);
    expect(variant.properties.createdAt.format).toBe('date-time');
    expect(variant.properties.id.pattern).toBeString();
  }
  expect(Object.keys(variants[1].properties).sort()).toEqual(['createdAt', 'id', 'kind', 'revision', 'state']);
});

test('installed watch inventory preserves sparse cursors, unavailable retry and private removal metadata', async () => {
  const accountId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const threadId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const threadResource = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const boardId = '019a1b2c-3d4e-7f00-8a00-000000000004';
  const boardResource = '019a1b2c-3d4e-7f00-8a00-000000000005';
  const identity = { revision: 2, createdAt: '2026-11-04T00:00:00.000Z' };
  const threadPage: WatchManagementPage = {
    items: [
      { ...identity, id: threadId, kind: 'thread', state: 'available', resourceId: threadResource, title: 'Watched thread' },
      { ...identity, id: `${threadId.slice(0, -1)}6`, kind: 'thread', state: 'unavailable' },
    ],
    next: null,
  };
  const boardPage: WatchManagementPage = {
    items: [
      { ...identity, id: boardId, kind: 'board', state: 'available', resourceId: boardResource, title: null },
      { ...identity, id: `${boardId.slice(0, -1)}7`, kind: 'board', state: 'unavailable' },
    ],
    next: null,
  };
  const removedId = boardPage.items[1]!.id;
  const removeKey = crypto.randomUUID();
  const boardKey = crypto.randomUUID();
  const answers = [
    Response.json({ items: [], next: 'opaque+/cursor=' }),
    Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
    Response.json(threadPage),
    Response.json(boardPage),
    Response.json({ removed: true }),
    Response.json({ removed: true }),
    Response.json({ watching: true, revision: 3 }),
    Response.json({ watching: false, revision: 4 }),
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
  const first = await inventory.get({ query });
  expect(first.data).toEqual({ items: [], next: 'opaque+/cursor=' });
  const resumed = { query: { ...query, cursor: first.data!.next! } };
  expect((await inventory.get(resumed)).status).toBe(503);
  expect((await inventory.get(resumed)).data).toEqual(threadPage);
  expect(sent[1]!.url).toBe(sent[2]!.url);
  expect(new URL(sent[2]!.url).searchParams.get('cursor')).toBe(first.data!.next);
  expect(threadPage.items.map((item) => item.state)).toEqual(['available', 'unavailable']);
  expect((await client.accounts({ accountId }).watches.get({ query: { kind: 'board', limit: 2 } })).data).toEqual(
    boardPage,
  );
  expect(boardPage.items.map((item) => item.state)).toEqual(['available', 'unavailable']);
  const remove = client.accounts({ accountId }).watches({ watchId: removedId });
  const removeOptions = {
    query: { kind: 'board' as const },
    headers: { 'idempotency-key': JSON.stringify(removeKey) },
  };
  expect((await remove.delete({ expectedRevision: 2 }, removeOptions)).data).toEqual({ removed: true });
  expect((await remove.delete({ expectedRevision: 2 }, removeOptions)).data).toEqual({ removed: true });
  const removed = sent[4]!;
  expect(removed.method).toBe('DELETE');
  expect(new URL(removed.url).pathname).toBe(`/v1/accounts/${accountId}/watches/${removedId}`);
  expect(new URL(removed.url).searchParams.get('kind')).toBe('board');
  expect(removed.headers.get('idempotency-key')).toBe(JSON.stringify(removeKey));
  expect(await removed.clone().json()).toEqual({ expectedRevision: 2 });
  expect(sent[4]!.url).toBe(sent[5]!.url);
  expect(sent[4]!.headers.get('idempotency-key')).toBe(sent[5]!.headers.get('idempotency-key'));
  expect(await sent[5]!.clone().json()).toEqual({ expectedRevision: 2 });
  const board = client.boards({ id: boardResource }).watch;
  expect((await board.get()).data).toEqual({ watching: true, revision: 3 });
  expect(
    (
      await board.put(
        { watching: false, expectedRevision: 3 },
        { headers: { 'idempotency-key': JSON.stringify(boardKey) } },
      )
    ).data,
  ).toEqual({ watching: false, revision: 4 });
  expect(sent[6]!.method).toBe('GET');
  expect(sent[7]!.method).toBe('PUT');
  expect(await sent[7]!.clone().json()).toEqual({ watching: false, expectedRevision: 3 });
  expect(sent[7]!.headers.get('idempotency-key')).toBe(JSON.stringify(boardKey));
});
