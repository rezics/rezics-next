import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { resourceFixture, type ResourceFixture } from '../zones/resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture({ scopes: ['follow:create', 'follow:delete', 'follow:read', 'follow:list'] });
  await f.available();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('published Zone follows use common receipts, bounded pages and retained-edge removal after read loss', async () => {
  const zones = [await f.create(), await f.create()];
  const privateAttempt = await f.call('owner', 'PUT', `/v1/follows/${zones[0]!.id}`);
  expect(privateAttempt.status).toBe(404);
  const receipts = new Map<
    string,
    { headers: Record<string, string>; body: Awaited<ReturnType<ResourceFixture['call']>>['body'] }
  >();
  for (const zone of zones) {
    const published = await f.call(
      'owner',
      'POST',
      `/v1/zones/${zone.id}:publish`,
      { visibility: 'public' },
      f.conditional(zone.revision),
    );
    expect(published.status).toBe(200);
    zone.revision = published.body.zone.revision;
    const headers = { 'idempotency-key': JSON.stringify(randomUUID()) };
    const followed = await f.call('editor', 'PUT', `/v1/follows/${zone.id}`, undefined, headers);
    receipts.set(zone.id, { headers, body: followed.body });
    expect(followed.status, JSON.stringify(followed.body)).toBe(200);
    expect(followed.body.follow).toMatchObject({
      targetId: zone.id,
      targetType: 'zone',
      state: 'following',
      reason: 'explicit',
    });
  }
  const first = await f.call('editor', 'GET', '/v1/follows?targetType=zone&view=FULL&limit=1');
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  expect(first.body.follows).toHaveLength(1);
  const shown = first.body.follows[0];
  expect(shown.target).toMatchObject({ id: shown.targetId, type: 'zone' });
  expect(shown.destination).toEqual({ kind: 'zone', zoneId: shown.targetId });
  const cursor = encodeURIComponent(first.body.next);
  expect(first.body.next).toEqual(expect.any(String));
  const second = await f.call('editor', 'GET', `/v1/follows?targetType=zone&view=FULL&limit=1&cursor=${cursor}`);
  expect(second.status).toBe(200);
  expect(second.body.follows[0].targetId).not.toBe(shown.targetId);
  expect(second.body.next).toBeNull();
  expect((await f.call('editor', 'GET', `/v1/follows?targetType=space&cursor=${cursor}`)).status).toBe(400);
  expect((await f.call('other', 'GET', `/v1/follows/${shown.targetId}`)).status).toBe(404);
  const receipt = receipts.get(shown.targetId)!;
  const key = receipt.headers;
  const target = zones.find((zone) => zone.id === shown.targetId)!;
  expect(
    (
      await f.call(
        'owner',
        'POST',
        `/v1/zones/${target.id}:publish`,
        { visibility: 'private' },
        f.conditional(target.revision),
      )
    ).status,
  ).toBe(200);
  const hidden = await f.call('editor', 'GET', `/v1/follows/${target.id}?view=FULL`);
  expect(hidden.body.follow).toMatchObject({ targetId: target.id, target: null, destination: { kind: 'unavailable' } });
  expect((await f.call('editor', 'PUT', `/v1/follows/${target.id}`, undefined, key)).body).toEqual(receipt.body);
  expect((await f.call('editor', 'PUT', `/v1/follows/${target.id}`)).status).toBe(404);
  expect((await f.call('editor', 'DELETE', `/v1/follows/${target.id}`)).body.follow.state).toBe('unfollowed');
  const deleted = zones.find((zone) => zone.id !== target.id)!;
  expect(
    (await f.call('owner', 'DELETE', `/v1/zones/${deleted.id}`, undefined, f.conditional(deleted.revision))).status,
  ).toBe(200);
  const gone = await f.call('editor', 'GET', `/v1/follows/${deleted.id}?view=FULL`);
  expect(gone.body.follow).toMatchObject({ target: null, destination: { kind: 'unavailable' } });
  const source = await f.db.admin.query(
    `SELECT revision::text, source_following FROM library.follow_count_source WHERE route=$1 AND account_id=$2 AND target_type='zone' AND target_id=$3`,
    [routeOf(f.accounts.editor), f.accounts.editor, target.id],
  );
  expect(source.rows).toEqual([{ revision: '2', source_following: false }]);
  const outgoing = await f.db.admin.query(
    'SELECT observed_live_count::text FROM library.follow_count_owner WHERE route=$1 AND account_id=$2',
    [routeOf(f.accounts.editor), f.accounts.editor],
  );
  expect(outgoing.rows).toEqual([{ observed_live_count: '1' }]);
}, 180_000);

test('withheld native labels stay concealed for an existing Zone follow', async () => {
  const zone = await f.create();
  const published = await f.call(
    'owner',
    'POST',
    `/v1/zones/${zone.id}:publish`,
    { visibility: 'public' },
    f.conditional(zone.revision),
  );
  expect(published.status).toBe(200);
  expect((await f.call('editor', 'PUT', `/v1/follows/${zone.id}`)).status).toBe(200);
  await f.grant(zone.id, 'operator', 'moderation:takedown');
  const hidden = await f.call(
    'operator',
    'POST',
    `/v1/zones/${zone.id}:takedown`,
    {
      notice: { complaint: 'Withheld subscription label', received_at: f.clock().toISOString() },
      fields: ['/labels'],
    },
    f.conditional(published.body.zone.revision),
  );
  expect(hidden.status).toBe(200);
  const result = await f.call('editor', 'GET', `/v1/follows/${zone.id}?view=FULL`);
  expect(result.status).toBe(200);
  expect(result.body.follow).toMatchObject({ target: null, destination: { kind: 'unavailable' } });
  expect((await f.call('editor', 'PUT', `/v1/follows/${zone.id}`)).status).toBe(404);
  expect((await f.call('editor', 'DELETE', `/v1/follows/${zone.id}`)).body.follow.state).toBe('unfollowed');
}, 180_000);
