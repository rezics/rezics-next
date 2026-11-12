import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { SESSION_HEADER } from '@rezics/operations/protocol';
import { nativeGrantor } from './support/native-system.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { HostedHistoryItem } from '../../src/content/hosted-chapters-history-model.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

const page = (id: string, cursor?: string, limit = 2) =>
  f.native.call(
    'GET',
    `/v1/hostedCatalogues/${id}/history?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

async function create(postId: string, threadId: string, placements: unknown[] = []) {
  return f.native.command('/v1/hostedCatalogues', { postId, threadId, placements });
}

test('authors discover safe exact structures and releases after removal and withdrawal, with stable bounded pages', async () => {
  const id = f.catalogueId;
  const path = `/v1/hostedCatalogues/${id}`;
  const part = f.newOccurrenceId();
  const chapter = f.newOccurrenceId();
  const targetThread = await f.native.thread();
  const target = f.target(targetThread);
  const initial = await create(id, f.threadId, [
    { occurrenceId: part, parentId: null, position: 0, title: 'Private part title', kind: 'part' },
    { occurrenceId: chapter, parentId: part, position: 0, title: 'Private chapter title', kind: 'chapter', target },
  ]);
  const release = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: initial.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [part, chapter],
    },
    200,
  );
  const removed = await f.native.command(
    `${path}:revise`,
    {
      expectedRevisionId: initial.revisionId,
      placements: [],
    },
    200,
  );
  const withdrawal = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: removed.revisionId,
      expectedPublicationId: release.revisionId,
      occurrenceIds: [],
    },
    200,
  );

  // Immutable fixture rows pin timestamp ties and precision below Date's
  // milliseconds. Their bodies/placements are empty, as allowed by the store.
  const route = routeOf(id)!;
  const tiedIds = [newId(route), newId(route), newId(route), newId(route)];
  const oldTimes = [
    '2000-01-01T00:00:00.123456Z',
    '2000-01-01T00:00:00.123456Z',
    '2000-01-01T00:00:00.123456Z',
    '2000-01-01T00:00:00.123455Z',
  ];
  await f.native.pool.query(
    `INSERT INTO content.hosted_structure_revision
      (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
     SELECT route,catalogue_id,x.id,'structure',NULL,recorded_transaction_id,x.created_at
     FROM content.hosted_structure_revision CROSS JOIN unnest($3::uuid[], $5::timestamptz[]) x(id,created_at)
     WHERE route=$1 AND catalogue_id=$2 AND revision_id=$4`,
    [route, id, tiedIds, initial.revisionId, oldTimes],
  );
  const expected = (
    await f.native.pool.query<{ revision_id: string }>(
      `SELECT revision_id FROM content.hosted_structure_revision
     WHERE route=$1 AND catalogue_id=$2 ORDER BY created_at DESC,revision_id DESC`,
      [route, id],
    )
  ).rows.map((row) => row.revision_id);
  const first = await page(id);
  expect(first.status).toBe(200);
  expect(first.value.items).toHaveLength(2);
  expect(first.value.nextCursor).toEqual(expect.any(String));

  // Save after taking a frontier. Earlier revisions keep their exact identity,
  // and current flags on continued pages come from current catalogue pointers.
  const later = await f.native.command(
    `${path}:revise`,
    { expectedRevisionId: removed.revisionId, placements: [] },
    200,
  );
  const items: HostedHistoryItem[] = [...first.value.items];
  let cursor = first.value.nextCursor as string | null;
  while (cursor) {
    const next = await page(id, cursor);
    expect(next.status).toBe(200);
    expect(next.value.items.length).toBeLessThanOrEqual(2);
    items.push(...next.value.items);
    cursor = next.value.nextCursor;
  }
  expect(items.map((item) => item.revisionId)).toEqual(expected);
  expect(new Set(items.map((item) => item.revisionId)).size).toBe(expected.length);
  expect(items.filter((item) => tiedIds.includes(item.revisionId)).map((item) => item.createdAt)).toEqual([
    ...oldTimes,
  ]);
  for (const item of items) {
    expect(Object.keys(item).sort()).toEqual([
      'catalogueId',
      'createdAt',
      'isCurrentDraft',
      'isCurrentRelease',
      'kind',
      'revisionId',
      'sourceRevisionId',
    ]);
  }
  const current = await page(id, undefined, 20);
  expect(current.value.nextCursor).toBeNull();
  expect(
    current.value.items
      .filter((item: HostedHistoryItem) => item.isCurrentDraft)
      .map((item: HostedHistoryItem) => item.revisionId),
  ).toEqual([later.revisionId]);
  expect(
    current.value.items
      .filter((item: HostedHistoryItem) => item.isCurrentRelease)
      .map((item: HostedHistoryItem) => item.revisionId),
  ).toEqual([withdrawal.revisionId]);
  expect(current.value.items.find((item: HostedHistoryItem) => item.revisionId === release.revisionId)).toMatchObject({
    kind: 'publication',
    sourceRevisionId: initial.revisionId,
  });
  expect(current.value.items.find((item: HostedHistoryItem) => item.revisionId === initial.revisionId)).toMatchObject({
    kind: 'structure',
    sourceRevisionId: null,
  });
  const oldStructure = await f.native.call('GET', `${path}?revisionId=${initial.revisionId}&kind=structure`);
  expect(oldStructure.value.revisionId).toBe(initial.revisionId);
  const frozen = await f.native.call(
    'GET',
    `${path}/occurrences/${chapter}?revisionId=${release.revisionId}&kind=publication`,
  );
  expect(frozen.value.occurrence.target).toEqual(target);
  expect(frozen.value.document.sha256).toBe(target.sha256);
  const empty = await f.native.call('GET', `${path}/children?revisionId=${withdrawal.revisionId}`);
  expect(empty.value.items).toEqual([]);
  const wire = await f.native.system.kernel.handle(
    new Request(`https://content.test${path}/history`, {
      headers: { authorization: `Bearer ${f.native.author.bearer}` },
    }),
  );
  expect(wire.headers.get('cache-control')).toBe('private, no-store');
  expect(wire.headers.get(SESSION_HEADER)).not.toBeNull();
});

test('history denies public and non-author traversal and rechecks revoked authority for retained cursors', async () => {
  const thread = await f.native.thread();
  const id = thread.firstPost.id;
  const path = `/v1/hostedCatalogues/${id}`;
  const initial = await create(id, thread.id);
  await f.native.command(`${path}:revise`, { expectedRevisionId: initial.revisionId, placements: [] }, 200);
  const first = await page(id, undefined, 1);
  expect(first.status).toBe(200);
  const token = first.value.nextCursor as string;
  expect(token).toEqual(expect.any(String));
  expect((await f.native.call('GET', `${path}/history`, undefined, { anonymous: true })).status).toBe(401);
  expect((await f.native.call('GET', `${path}/history`, undefined, { other: true })).status).toBe(404);
  expect((await page(id, token, 2)).status).toBe(400);
  expect((await page(f.catalogueId, token, 1)).status).toBe(400);
  for (const query of ['limit=0', 'limit=21', 'cursor=bad', 'kind=structure'])
    expect((await f.native.call('GET', `${path}/history?${query}`)).status).toBe(400);

  const route = routeOf(id)!;
  const authorId = f.native.author.actor.accountId;
  const ownerValid = (
    await f.native.pool.query<{ valid: string }>(
      `SELECT valid::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='content.post.owner'`,
      [route, id, authorId],
    )
  ).rows[0]!.valid;
  const revoked = await f.native.system.kernel.handle(
    new Request('https://content.test/v1/roleGrants:revoke', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${nativeGrantor(f.native.system).bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({
        resource: { route, id },
        subject: { kind: 'account', id: authorId },
        role: 'content.post.owner',
        valid: ownerValid,
      }),
    }),
  );
  expect(revoked.status, await revoked.text()).toBe(200);
  const denied = await page(id, token, 1);
  expect([403, 404]).toContain(denied.status);
  expect(denied.value).not.toHaveProperty('items');
});
