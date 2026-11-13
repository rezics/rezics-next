import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

test('mounted draft point routes admit owners, replay, and expose versioned children', async () => {
  const catalogue = await f.native.thread();
  const catalogueId = catalogue.firstPost.id;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const insertPath = `${path}:insertDraftPoint`;
  const removePath = `${path}:removeDraftPoint`;
  const created = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: catalogue.id,
    placements: [],
  });
  expect(created.status).toBe(201);
  const partId = f.newOccurrenceIdFor(catalogueId);
  const chapterId = f.newOccurrenceIdFor(catalogueId);
  const target = f.target(await f.native.thread());
  const firstInput = {
    expectedRevisionId: created.value.revisionId,
    occurrenceId: partId,
    parentId: null,
    beforeOccurrenceId: null,
    title: 'Opening part',
    placement: { kind: 'part' as const },
  };
  const send = (pathName: string, input: unknown, key: string, bearer = f.native.author.bearer) =>
    f.native.system.kernel.handle(
      new Request(`https://content.test${pathName}`, {
        method: 'POST',
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
        },
        body: JSON.stringify(input),
      }),
    );

  expect((await f.native.call('POST', insertPath, firstInput, { other: true })).status).toBe(403);
  expect((await f.native.call('POST', insertPath, firstInput, { anonymous: true })).status).toBe(401);
  expect((await f.native.call('POST', insertPath, { ...firstInput, extra: true })).status).toBe(400);

  const partition = partitionOf(routeOf(catalogueId)!);
  const before = await readPartition(f.native.pool, partition);
  const key = crypto.randomUUID();
  const response = await send(insertPath, firstInput, key);
  const value = await response.json();
  expect(response.status).toBe(200);
  expect(value).toEqual({ catalogueId, revisionId: expect.any(String) });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const after = await readPartition(f.native.pool, partition);
  expect(after?.position).toBe(before!.position + 1n);
  expect(
    decodeSession(
      f.native.system.tokenKeys,
      `account:${f.native.author.actor.accountId}`,
      response.headers.get(SESSION_HEADER)!,
    ),
  ).toEqual([{ partition, epoch: after!.epoch, position: after!.position }]);

  const replay = await send(insertPath, firstInput, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(value);
  expect(replay.headers.get(SESSION_HEADER)).toBe(response.headers.get(SESSION_HEADER));

  const children = await f.native.call('GET', `${path}/children?kind=structure`);
  expect(children.status).toBe(200);
  expect(children.value.items).toEqual([
    expect.objectContaining({
      occurrenceId: partId,
      parentId: null,
      position: 0,
      kind: 'part',
      availability: 'available',
      title: 'Opening part',
    }),
  ]);

  const nested = await f.native.call('POST', insertPath, {
    expectedRevisionId: value.revisionId,
    occurrenceId: chapterId,
    parentId: partId,
    beforeOccurrenceId: null,
    title: 'First chapter',
    placement: { kind: 'chapter', target },
  });
  expect(nested.status).toBe(200);
  const nestedChildren = await f.native.call('GET', `${path}/children?kind=structure&parentId=${partId}`);
  expect(nestedChildren.value.items).toEqual([
    expect.objectContaining({ occurrenceId: chapterId, parentId: partId, kind: 'chapter', target }),
  ]);

  expect(
    (
      await f.native.call('POST', insertPath, {
        ...firstInput,
        expectedRevisionId: created.value.revisionId,
        occurrenceId: f.newOccurrenceIdFor(catalogueId),
      })
    ).status,
  ).toBe(412);

  const removed = await f.native.call('POST', removePath, {
    expectedRevisionId: nested.value.revisionId,
    occurrenceId: partId,
  });
  expect(removed.status).toBe(200);
  expect((await f.native.call('GET', `${path}/children?kind=structure`)).value.items).toEqual([]);
  expect((await f.native.call('GET', `${path}/occurrences/${chapterId}?kind=structure`)).status).toBe(404);
  const pinned = await f.native.call(
    'GET',
    `${path}/children?kind=structure&parentId=${partId}&revisionId=${nested.value.revisionId}`,
  );
  expect(pinned.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([chapterId]);
});
