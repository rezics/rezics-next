import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/operations/protocol';
import * as access from '../../src/content/access-port.ts';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let observer: ReturnType<typeof observeSql>;
let source: Awaited<ReturnType<typeof f.native.thread>>;
let ids: string[], draft: string, release: string, path: string;
beforeAll(async () => {
  f = await hostedChaptersFixture();
  ids = Array.from({ length: 5 }, () => f.newOccurrenceId());
  path = `/v1/hostedCatalogues/${f.catalogueId}`;
  source = await f.native.thread();
  const target = f.target(source);
  const placements = ids.map((occurrenceId, i) => ({
    occurrenceId,
    parentId: i === 1 || i === 2 ? ids[0] : i === 3 ? ids[2] : null,
    position: i === 2 || i === 4 ? 1 : 0,
    title: `Slot ${i}`,
    ...(i === 3 ? { kind: 'chapter', target } : { kind: 'part' }),
  }));
  draft = (
    await f.native.command('/v1/hostedCatalogues', {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements,
    })
  ).revisionId;
  release = (
    await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: draft,
        expectedPublicationId: null,
        occurrenceIds: ids,
      },
      200,
    )
  ).revisionId;
  observer = observeSql(f.native.pool);
});
afterAll(async () => {
  await observer?.close();
  await f?.close();
});
const get = (query = '', options = {}) => f.native.call('GET', `${path}/outline?${query}`, undefined, options);
const pages = (start: number) => observer.records.slice(start).filter((row) => row.statement.includes('p.ordinal>$4'));

test('one bounded preorder stream preserves nested and empty parts, exact revisions and zero body reads', async () => {
  const start = observer.records.length;
  const first = await get('kind=structure&limit=2');
  expect(first.status).toBe(200);
  await f.native.command(`${path}:revise`, { expectedRevisionId: draft, placements: [] }, 200);
  const items = [...first.value.items];
  let cursor = first.value.nextCursor;
  const nativeRead = reads.readPostMetadata;
  const hook = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2] === source.firstPost.id) expect((await f.native.revise(source.firstPost, {})).status).toBe(200);
    return result;
  });
  try {
    while (cursor) {
      const next = await get(`kind=structure&limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(next.status).toBe(200);
      expect(next.value.revisionId).toBe(draft);
      items.push(...next.value.items);
      cursor = next.value.nextCursor;
    }
  } finally {
    hook.mockRestore();
  }
  expect(items[3]).toEqual({
    occurrenceId: ids[3],
    parentId: ids[2],
    position: 0,
    kind: 'chapter',
    availability: 'unavailable',
  });
  expect(items.map((item) => [item.occurrenceId, item.parentId, item.position])).toEqual([
    [ids[0], null, 0],
    [ids[1], ids[0], 0],
    [ids[2], ids[0], 1],
    [ids[3], ids[2], 0],
    [ids[4], null, 1],
  ]);
  expect(pages(start).map((row) => row.parameters.slice(2))).toEqual([
    [draft, -1, 3],
    [draft, 1, 3],
    [draft, 3, 3],
  ]);
  for (const query of ['limit=3', 'kind=publication&limit=2', `revisionId=${draft}&limit=2`]) {
    const result = await get(query);
    expect(result.status).toBe(200);
    expect(result.value.items).toHaveLength(query === 'limit=3' ? 3 : 2);
  }
  for (const [suffix, options, status] of [
    ['', { anonymous: true }, 401],
    ['', { other: true }, 404],
    ['parentId=' + ids[0], {}, 400],
    ['limit=21', {}, 400],
    ['limit=2&cursor=' + encodeURIComponent(first.value.nextCursor), {}, 400],
  ] as const)
    expect((await get(suffix, options)).status).toBe(status);
  expect(
    (
      await f.native.call(
        'GET',
        `${path}/children?kind=structure&limit=2&cursor=${encodeURIComponent(first.value.nextCursor)}`,
      )
    ).status,
  ).toBe(400);
  const response = await f.native.system.kernel.handle(
    new Request(`https://content.test${path}/outline`, {
      headers: { authorization: `Bearer ${f.native.author.bearer}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get(SESSION_HEADER)).toEqual(expect.any(String));
  expect((await response.json()).revisionId).toBe(release);
  expect(
    observer.records
      .slice(start)
      .filter(
        (row) => row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
      ),
  ).toHaveLength(0);
});

test('release pages recheck revise at admission, on continuation and at the final retained check', async () => {
  const first = await get('limit=1');
  const original = access.accessCheck;
  for (const denyAt of [1, 2]) {
    let checks = 0;
    const hook = spyOn(access, 'accessCheck').mockImplementation(async (...args) => {
      const check = await original(...args);
      return async (client) => (args[2] === 'post:revise' && ++checks === denyAt ? false : check(client));
    });
    const start = observer.records.length;
    try {
      const result = await get('limit=1&cursor=' + encodeURIComponent(first.value.nextCursor));
      expect(result.status).toBe(404);
      expect(result.value).not.toHaveProperty('items');
      expect(checks).toBe(denyAt);
      expect(pages(start)).toHaveLength(denyAt - 1);
    } finally {
      hook.mockRestore();
    }
  }
});
