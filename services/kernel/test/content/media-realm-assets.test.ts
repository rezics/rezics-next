import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createImageJob } from '../../src/content/image-job.ts';
import { claimRealmPresentationMedia, readRealmPresentationImages } from '../../src/content/realm-media.ts';
import { eraseAccountUploadItem } from '../../src/content/account-erasure-uploads.ts';
import { runCommand } from '../../src/command/command.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { testAccess } from '../support/test-kernel.ts';
import { mediaRealmDownloadFixture } from './media-realm-download-fixture.ts';

setDefaultTimeout(360_000);
let fixture: Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;
let deps: Parameters<typeof readRealmPresentationImages>[0];
beforeAll(async () => {
  fixture = await mediaRealmDownloadFixture();
  deps = {
    pool: fixture.db.pool,
    access: testAccess({
      pool: fixture.db.pool,
      actions: actionCatalogue(fixture.kernel),
      auth: {
        ...fixture.auth.host.service.verifier,
        fetch: (url, init) => fixture.auth.host.service.handler(new Request(url, init)),
      },
    }),
  };
}, 240_000);
afterAll(async () => fixture?.close());

async function upload(
  realmId: string,
  purpose: 'realm-icon' | 'realm-banner',
  bearer = fixture.governor.bearer,
  websiteBearer = fixture.governor.websiteBearer,
  process = true,
) {
  const bytes = await sharp({ create: { width: 96, height: 48, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = crypto.randomUUID();
  const media = (
    await fixture.checked(
      'POST',
      `/v1/realms/${realmId}/media`,
      {
        purpose,
        mediaType: 'image/png',
        byteCount: bytes.length,
        sha256,
      },
      201,
      { bearer, key },
    )
  ).media as { id: string };
  expect(routeOf(media.id)).toBe(routeOf(realmId));
  await fixture.storage.storage.put(`m/${media.id}/original`, bytes, { mediaType: 'image/png' });
  await fixture.checked(
    'POST',
    `/v1/media/${media.id}:complete`,
    {
      containerId: realmId,
      reservationRequestId: key,
      byteCount: bytes.length,
      sha256,
    },
    200,
    { bearer: websiteBearer },
  );
  if (process)
    expect((await createImageJob(fixture.db.pool, fixture.storage.storage).process(media.id)).state).toBe('available');
  return media.id;
}

async function select(
  realmId: string,
  avatarMediaId: string | null,
  bannerMediaId: string | null,
  bearer = fixture.governor.bearer,
) {
  const current = await fixture.readRealm(realmId, fixture.governor.bearer);
  expect(current.response.status).toBe(200);
  return fixture.call('PATCH', `/v1/realms/${realmId}`, {
    bearer,
    headers: { 'if-match': JSON.stringify(current.value.realm.headRevisionId) },
    body: { presentation: { avatarMediaId, bannerMediaId, rules: null } },
  });
}
async function summaries(
  realmId: string,
  avatarMediaId: string | null,
  bannerMediaId: string | null,
  bearer: string | null = fixture.governor.bearer,
) {
  const actor =
    bearer === null
      ? { kind: 'anonymous' as const }
      : await deps.access.authenticate(bearer, {
          pool: fixture.db.pool,
          deadline: Date.now() + 30_000,
        });
  return readRealmPresentationImages(
    deps,
    { realmId, avatarMediaId, bannerMediaId },
    { actor, deadline: Date.now() + 30_000 },
  );
}

// These use the ordinary Realm settings consumer of Content's exported claim API.
// That consumer is delivered separately; neither a private claim route nor a test command grants success.
test('native Realm management selects only matching available same-Realm uploader media and preserves revision claims', async () => {
  const realmId = fixture.publicRealm.realmId;
  const refused = await fixture.call('POST', `/v1/realms/${realmId}/media`, {
    bearer: fixture.alice.bearer,
    body: { purpose: 'realm-icon', mediaType: 'image/png', byteCount: 10 },
  });
  expect(refused.response.status).toBe(403);
  for (const purpose of ['avatar', 'post-image', 'cover']) {
    expect(
      (
        await fixture.call('POST', `/v1/realms/${realmId}/media`, {
          body: { purpose, mediaType: 'image/png', byteCount: 10 },
        })
      ).response.status,
    ).toBe(400);
  }
  const icon = await upload(realmId, 'realm-icon');
  const banner = await upload(realmId, 'realm-banner');
  const unprocessed = await upload(realmId, 'realm-icon', undefined, undefined, false);
  const remote = await upload(fixture.protectedRealm.realmId, 'realm-icon');
  await fixture.grant(fixture.alice.accountId, realmId, ['realm:manage']);
  const otherUploader = await upload(realmId, 'realm-icon', fixture.alice.bearer, fixture.alice.websiteBearer);
  const reservation = await fixture.call('GET', `/v1/media/${otherUploader}`, { bearer: fixture.alice.bearer });
  expect(reservation.response.status).toBe(200);
  await fixture.revoke(realmId, fixture.alice.accountId, ['realm:manage']);
  expect(
    (
      await fixture.call('POST', `/v1/media/${otherUploader}:complete`, {
        bearer: fixture.alice.websiteBearer,
        body: {
          containerId: realmId,
          reservationRequestId: reservation.value.media.reservationRequestId,
          byteCount: reservation.value.media.byteCount,
          sha256: reservation.value.media.sha256,
        },
      })
    ).response.status,
  ).toBe(403);

  for (const [avatar, cover] of [
    [banner, null],
    [unprocessed, null],
    [remote, null],
    [otherUploader, null],
    [newId(routeOf(realmId)!), null],
    [icon, icon],
  ] as const) {
    expect((await select(realmId, avatar, cover)).response.status).toBe(409);
  }
  const actor = await deps.access.authenticate(fixture.governor.bearer, {
    pool: fixture.db.pool,
    deadline: Date.now() + 30_000,
  });
  await expect(
    runCommand(fixture.db.pool, { partition: partitionOf(routeOf(realmId)!) }, async (tx) => {
      await claimRealmPresentationMedia(tx, { realmId, author: actor, avatarMediaId: icon, bannerMediaId: banner });
      throw new Error('Standalone claim must never execute');
    }),
  ).rejects.toThrow(GrantDeniedError);
  expect((await select(realmId, icon, banner)).response.status).toBe(200);
  const result = await summaries(realmId, icon, banner, null);
  expect(result.avatar).toMatchObject({
    state: 'available',
    value: { id: icon, containerId: realmId, width: 96, height: 48, credit: null },
  });
  expect(result.banner.state).toBe('available');
  if (result.avatar.state === 'available') {
    expect(result.avatar.value.variants).toHaveLength(2);
    expect(JSON.stringify(result.avatar.value)).not.toMatch(/original|uploader|sourceUrl|"key"/);
  }
  expect((await select(realmId, null, null)).response.status).toBe(200);
  expect(await summaries(realmId, null, null)).toEqual({
    avatar: { state: 'none', value: null },
    banner: { state: 'none', value: null },
  });
  const claims = await fixture.db.admin.query(
    'SELECT claimed_realm_id FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[])',
    [routeOf(realmId), [icon, banner]],
  );
  expect(claims.rows).toEqual([{ claimed_realm_id: realmId }, { claimed_realm_id: realmId }]);
  expect(
    await eraseAccountUploadItem(
      { pool: fixture.db.pool, storage: fixture.storage.storage },
      fixture.governor.accountId,
      'media',
      icon,
    ),
  ).toBe('retained');
});

test('current Realm loss hides summaries and denies conditional derivative downloads despite media ownership', async () => {
  const realmId = fixture.protectedRealm.realmId;
  await fixture.grant(fixture.alice.accountId, realmId, ['realm:manage']);
  const icon = await upload(realmId, 'realm-icon', fixture.alice.bearer, fixture.alice.websiteBearer);
  expect((await select(realmId, icon, null, fixture.alice.bearer)).response.status).toBe(200);
  expect((await summaries(realmId, icon, null, fixture.alice.bearer)).avatar.state).toBe('available');
  expect((await summaries(realmId, icon, null, null)).avatar).toEqual({ state: 'none', value: null });
  expect((await fixture.download(icon, 'original', fixture.alice.bearer)).response.status).toBe(404);
  const available = await fixture.download(icon, 'webp-96', fixture.alice.bearer);
  expect(available.response.status).toBe(200);
  const conditional = { 'if-none-match': JSON.stringify(available.value.sha256) };
  // Keep exact media ownership and realm:manage while removing current realm:read.
  await fixture.revoke(realmId, fixture.alice.accountId, ['realm:read']);
  expect((await summaries(realmId, icon, null, fixture.alice.bearer)).avatar).toEqual({ state: 'none', value: null });
  expect((await fixture.download(icon, 'webp-96', fixture.alice.bearer, conditional)).response.status).toBe(404);
  await fixture.grant(fixture.alice.accountId, realmId, ['realm:read']);
  expect((await fixture.download(icon, 'webp-96', fixture.alice.bearer, conditional)).response.status).toBe(200);
  await fixture.checked('DELETE', `/v1/media/${icon}`, undefined, 204, { bearer: fixture.alice.bearer });
  expect((await summaries(realmId, icon, null, fixture.alice.bearer)).avatar).toEqual({ state: 'none', value: null });
  expect((await fixture.download(icon, 'webp-96', fixture.alice.bearer, conditional)).response.status).toBe(404);
});
