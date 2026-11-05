import { afterAll, beforeAll, expect, test } from 'bun:test';
import mediaRead from '../../src/content/realm-media-read.sql';
import { routeOf } from '../../src/route/route.ts';
import { growthRealmPresentationClaimFixture } from '../content/support/growth-realm-presentation-claim-fixture.ts';

let f: Awaited<ReturnType<typeof growthRealmPresentationClaimFixture>>;
beforeAll(async () => {
  f = await growthRealmPresentationClaimFixture();
}, 240_000);
afterAll(async () => {
  await f?.close();
});

test.serial(
  'settings resolve native claimed avatar and banner without changing media or command state',
  async () => {
    const realm = await f.createRealm('Settings with selected native media');
    const avatar = await f.upload(realm.realmId, 'realm-icon');
    const banner = await f.upload(realm.realmId, 'realm-banner');
    const presentation = { avatarMediaId: avatar.id, bannerMediaId: banner.id, rules: null };
    const key = crypto.randomUUID();
    const saved = await f.patch(realm.realmId, realm.headRevisionId, presentation, key);
    expect(saved.response.status).toBe(200);
    const writeCounts = async () =>
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
      writes: await writeCounts(),
    };
    const page = await f.base.call('GET', `/v1/realms/${realm.realmId}/settings`, { bearer: f.base.governor.bearer });
    expect(page.response.status).toBe(200);
    expect(page.value.snapshot).toMatchObject({
      head: saved.value.realm.headRevisionId,
      presentation,
      avatar: { state: 'available', value: { id: avatar.id, containerId: realm.realmId } },
      banner: { state: 'available', value: { id: banner.id, containerId: realm.realmId } },
      rules: { state: 'none', value: null },
    });
    for (const slot of ['avatar', 'banner'] as const) {
      const value = page.value.snapshot[slot].value;
      expect(value.variants.length).toBeGreaterThan(0);
      expect(value.variants.length).toBeLessThanOrEqual(12);
      expect(Object.keys(value).sort()).toEqual(
        ['id', 'containerId', 'digest', 'width', 'height', 'variants', 'placeholder', 'focalPoint', 'credit'].sort(),
      );
      expect(value.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect({
      media: await f.mediaRows([avatar.id, banner.id]),
      receipts: await f.receiptCount([key]),
      revisions: await f.revisionCount(realm.realmId),
      writes: await writeCounts(),
    }).toEqual(before);

    // Historical optional metadata must be bounded at acquisition, while the
    // valid image, selected keys and current descriptor grants remain usable.
    const route = routeOf(avatar.id)!;
    const original = (
      await f.base.db.admin.query('SELECT thumbhash, average_color FROM content.media WHERE route=$1 AND media_id=$2', [
        route,
        avatar.id,
      ])
    ).rows[0];
    try {
      for (const size of [32, 33, 65_536]) {
        await f.base.db.admin.query(
          'UPDATE content.media SET thumbhash=$3, average_color=$4 WHERE route=$1 AND media_id=$2',
          [route, avatar.id, Buffer.alloc(size, 1), size === 32 ? '#ABCDEF' : 'x'.repeat(size)],
        );
        const raw = await mediaRead.run(f.base.db.pool, { route, media_id: avatar.id });
        expect(raw?.thumbhash).toBe(size === 32 ? Buffer.alloc(32, 1).toString('base64') : null);
        expect(raw?.average_color).toBe(size === 32 ? '#ABCDEF' : null);
        const bounded = await f.base.call('GET', `/v1/realms/${realm.realmId}/settings`, {
          bearer: f.base.governor.bearer,
        });
        expect(bounded.response.status).toBe(200);
        expect(bounded.value.snapshot.avatar.state).toBe('available');
        expect(bounded.value.snapshot.avatar.value.placeholder).toEqual(
          size === 32 ? { thumbhash: raw!.thumbhash, color: '#ABCDEF' } : null,
        );
        expect(bounded.value.snapshot.banner).toEqual(page.value.snapshot.banner);
      }
    } finally {
      await f.base.db.admin.query(
        'UPDATE content.media SET thumbhash=$3, average_color=$4 WHERE route=$1 AND media_id=$2',
        [route, avatar.id, original.thumbhash, original.average_color],
      );
    }

    const sparse = await f.patch(
      realm.realmId,
      saved.value.realm.headRevisionId,
      { ...presentation, bannerMediaId: null },
      crypto.randomUUID(),
    );
    expect(sparse.response.status).toBe(200);
    const readback = await f.base.call('GET', `/v1/realms/${realm.realmId}/settings`, {
      bearer: f.base.governor.bearer,
    });
    expect(readback.response.status).toBe(200);
    expect(readback.value.snapshot.avatar.state).toBe('available');
    expect(readback.value.snapshot.banner).toEqual({ state: 'none', value: null });
    expect(await f.mediaRows([avatar.id, banner.id])).toEqual(before.media);
  },
  120_000,
);
