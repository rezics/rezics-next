import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { hostedRootAppendBase } from './support/hosted-root-append-setup.ts';
import type { HostedRootAppendInput } from '../../src/content/hosted-chapters-model.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { readPartition } from '../../src/partition/partition.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

test('rejects malformed trees and cross-route selectors at HTTP boundaries and enforces Post revise authority', async () => {
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const left = f.newOccurrenceId();
  const right = f.newOccurrenceId();
  const cyclic = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements: [
      { occurrenceId: left, parentId: right, position: 0, title: 'Left', kind: 'part' },
      { occurrenceId: right, parentId: left, position: 0, title: 'Right', kind: 'part' },
    ],
  });
  expect(cyclic.status).toBe(400);

  const foreignRoute = ((routeOf(f.catalogueId) ?? 0) + 1) % 65_536;
  const invalidSelector = await f.native.call('GET', `${path}?revisionId=${newId(foreignRoute)}`);
  expect(invalidSelector.status).toBe(400);

  const empty = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements: [],
  });
  expect(empty.status).toBe(201);
  const denied = await f.native.call(
    'POST',
    `${path}:revise`,
    {
      expectedRevisionId: empty.value.revisionId,
      placements: [],
    },
    { other: true },
  );
  expect(denied.status).toBe(403);
});

test('mounted root append admits owners, replays its anchor, and leaves the release and replacement bound intact', async () => {
  const catalogue = await f.native.thread();
  const catalogueRoute = routeOf(catalogue.firstPost.id);
  if (catalogueRoute === null) throw new Error('Mounted append catalogue has no route');
  const fixture = {
    ...f,
    catalogueId: catalogue.firstPost.id,
    threadId: catalogue.id,
    newOccurrenceId: () => newId(catalogueRoute),
    newOccurrenceIdFor: (id: string) => newId(routeOf(id)!),
  };
  const { path, target, placements, created } = await hostedRootAppendBase(fixture);
  const appendPath = `${path}:appendRootChapter`;
  const partition = partitionOf(routeOf(fixture.catalogueId)!);
  const firstInput: HostedRootAppendInput = {
    expectedRevisionId: created.revisionId,
    occurrenceId: fixture.newOccurrenceId(),
    title: 'After the whole base',
    target,
  };
  const send = (input: HostedRootAppendInput, key: string, bearer = fixture.native.author.bearer) =>
    fixture.native.system.kernel.handle(
      new Request(`https://content.test${appendPath}`, {
        method: 'POST',
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
        },
        body: JSON.stringify(input),
      }),
    );

  expect((await fixture.native.call('POST', appendPath, firstInput, { other: true })).status).toBe(403);
  expect((await fixture.native.call('POST', appendPath, firstInput, { anonymous: true })).status).toBe(401);

  const releaseBefore = await fixture.native.call('GET', `${path}/children`, undefined, { anonymous: true });
  expect(releaseBefore.status).toBe(200);
  const before = await readPartition(fixture.native.pool, partition);
  const key = crypto.randomUUID();
  const response = await send(firstInput, key);
  const value = await response.json();
  expect(response.status).toBe(200);
  expect(value).toEqual({ catalogueId: fixture.catalogueId, revisionId: expect.any(String) });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const after = await readPartition(fixture.native.pool, partition);
  expect(after?.position).toBe(before!.position + 1n);
  expect(
    decodeSession(
      fixture.native.system.tokenKeys,
      `account:${fixture.native.author.actor.accountId}`,
      response.headers.get(SESSION_HEADER)!,
    ),
  ).toEqual([{ partition, epoch: after!.epoch, position: after!.position }]);

  const stale = await fixture.native.call('POST', appendPath, {
    ...firstInput,
    expectedRevisionId: created.revisionId,
    occurrenceId: fixture.newOccurrenceId(),
  });
  expect(stale.status).toBe(412);

  let head = value.revisionId as string;
  let position512Occurrence = firstInput.occurrenceId;
  for (let offset = 1; offset < 16; offset++) {
    const input: HostedRootAppendInput = {
      expectedRevisionId: head,
      occurrenceId: fixture.newOccurrenceId(),
      title: `Additional chapter ${offset}`,
      target,
    };
    const next = await fixture.native.call('POST', appendPath, input);
    expect(next.status).toBe(200);
    head = next.value.revisionId;
    position512Occurrence = input.occurrenceId;
  }
  const pinnedRevisionId = head;
  const futureInput: HostedRootAppendInput = {
    expectedRevisionId: head,
    occurrenceId: fixture.newOccurrenceId(),
    title: 'After the pinned outline',
    target,
  };

  const replay = await send(firstInput, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(value);
  expect(replay.headers.get(SESSION_HEADER)).toBe(response.headers.get(SESSION_HEADER));

  const outlineQuery = `revisionId=${pinnedRevisionId}&kind=structure&limit=20`;
  let page = await fixture.native.call('GET', `${path}/outline?${outlineQuery}`);
  expect(page.status).toBe(200);
  expect(page.value.revisionId).toBe(pinnedRevisionId);
  const outline = [...page.value.items];
  const cursor = page.value.nextCursor;
  const later = await fixture.native.call('POST', appendPath, futureInput);
  expect(later.status).toBe(200);
  let nextCursor = cursor;
  while (nextCursor) {
    page = await fixture.native.call('GET', `${path}/outline?${outlineQuery}&cursor=${encodeURIComponent(nextCursor)}`);
    expect(page.status).toBe(200);
    expect(page.value.revisionId).toBe(pinnedRevisionId);
    outline.push(...page.value.items);
    nextCursor = page.value.nextCursor;
  }
  expect(outline).toHaveLength(528);
  expect(outline.at(-1)).toMatchObject({ occurrenceId: position512Occurrence, parentId: null, position: 512 });
  expect(outline.some((item: { occurrenceId: string }) => item.occurrenceId === futureInput.occurrenceId)).toBe(false);

  const releaseAfter = await fixture.native.call('GET', `${path}/children`, undefined, { anonymous: true });
  expect(releaseAfter.value).toEqual(releaseBefore.value);
  expect(
    releaseAfter.value.items.some((item: { occurrenceId: string }) => item.occurrenceId === firstInput.occurrenceId),
  ).toBe(false);

  const tooMany = await fixture.native.call('POST', `${path}:revise`, {
    expectedRevisionId: later.value.revisionId,
    placements: [
      ...placements,
      {
        occurrenceId: fixture.newOccurrenceId(),
        parentId: null,
        position: 497,
        title: 'The replacement limit still applies',
        kind: 'chapter',
        target,
      },
    ],
  });
  expect(tooMany.status).toBe(400);
});
