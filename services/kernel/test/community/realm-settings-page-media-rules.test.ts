import { afterAll, beforeAll, expect, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import { growthRealmPresentationClaimFixture } from '../content/support/growth-realm-presentation-claim-fixture.ts';

let f: Awaited<ReturnType<typeof growthRealmPresentationClaimFixture>>;
beforeAll(async () => {
  f = await growthRealmPresentationClaimFixture();
}, 240_000);
afterAll(async () => {
  await f?.close();
});

test.serial('settings compose two available images with exact pinned rules and conceal withdrawn media', async () => {
  const realm = f.base.protectedRealm;
  const avatar = await f.upload(realm.realmId, 'realm-icon');
  const banner = await f.upload(realm.realmId, 'realm-banner');
  const route = routeOf(f.base.privateImage.id);
  expect(route).not.toBeNull();
  const claim = await f.base.db.admin.query<{ postId: string | null }>(
    `SELECT claimed_item_id::text AS "postId" FROM content.media WHERE route=$1 AND media_id=$2`,
    [route, f.base.privateImage.id],
  );
  const postId = claim.rows[0]?.postId;
  expect(postId).toBeString();
  const source = await f.base.call('GET', `/v1/posts/${postId}`, { bearer: f.base.governor.bearer });
  expect(source.response.status).toBe(200);
  const pin = { postId: postId!, revisionId: source.value.post.revisionId as string };
  const presentation = { avatarMediaId: avatar.id, bannerMediaId: banner.id, rules: pin };
  const current = await f.read(realm.realmId);
  const key = crypto.randomUUID();
  const saved = await f.base.call('PATCH', `/v1/realms/${realm.realmId}`, {
    bearer: f.base.governor.bearer,
    key,
    headers: { 'if-match': JSON.stringify(current.headRevisionId) },
    body: { presentation },
  });
  expect(saved.response.status, JSON.stringify(saved.value)).toBe(200);

  const counts = async () =>
    (
      await f.base.db.admin.query(`SELECT
        (SELECT count(*) FROM core.receipt) AS receipts,
        (SELECT count(*) FROM core.outbox) AS events,
        (SELECT count(*) FROM content.media) AS media`)
    ).rows[0];
  const before = {
    media: await f.mediaRows([avatar.id, banner.id]),
    receipts: await f.receiptCount([key]),
    revisions: await f.revisionCount(realm.realmId),
    writes: await counts(),
  };
  const path = `/v1/realms/${realm.realmId}/settings`;
  const page = await f.base.call('GET', path, { bearer: f.base.governor.bearer });
  expect(page.response.status, JSON.stringify(page.value)).toBe(200);
  expect(page.response.headers.get('etag')).toBe(JSON.stringify(saved.value.realm.headRevisionId));
  expect(page.value.snapshot).toMatchObject({
    presentation,
    avatar: { state: 'available', value: { id: avatar.id, containerId: realm.realmId } },
    banner: { state: 'available', value: { id: banner.id, containerId: realm.realmId } },
    rules: {
      state: 'available',
      value: { postId: pin.postId, revisionId: pin.revisionId, licence: 'MIT', sha256: source.value.post.sha256 },
    },
  });
  for (const slot of ['avatar', 'banner'] as const) {
    const value = page.value.snapshot[slot].value;
    expect(value.variants.length).toBeGreaterThan(0);
    expect(value.variants.length).toBeLessThanOrEqual(12);
    expect(Object.keys(value).sort()).toEqual(
      ['id', 'containerId', 'digest', 'width', 'height', 'variants', 'placeholder', 'focalPoint', 'credit'].sort(),
    );
  }
  expect(await f.mediaRows([avatar.id, banner.id])).toEqual(before.media);
  expect(await f.receiptCount([key])).toBe(before.receipts);
  expect(await f.revisionCount(realm.realmId)).toBe(before.revisions);
  expect(await counts()).toEqual(before.writes);

  const withdrawn = await f.base.call('POST', `/v1/media/${avatar.id}:takeDown`, {
    bearer: f.base.governor.bearer,
    body: { reason: 'Withdraw the selected Realm avatar' },
  });
  expect(withdrawn.response.status, JSON.stringify(withdrawn.value)).toBe(200);
  const concealed = await f.base.call('GET', path, { bearer: f.base.governor.bearer });
  expect(concealed.response.status, JSON.stringify(concealed.value)).toBe(200);
  expect(concealed.value.snapshot.presentation.avatarMediaId).toBe(avatar.id);
  expect(concealed.value.snapshot.avatar).toEqual({ state: 'none', value: null });
  expect(concealed.value.snapshot.banner.state).toBe('available');
  expect(concealed.value.snapshot.rules.state).toBe('available');
  expect(JSON.stringify(concealed.value)).not.toContain(avatar.sha256);
});
