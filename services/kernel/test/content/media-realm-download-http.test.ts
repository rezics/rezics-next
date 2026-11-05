import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  assertAbsentMetadata,
  mediaRealmDownloadFixture,
  normalizedProblem,
  type MediaRealmPerson,
  type NativeImage,
} from './media-realm-download-fixture.ts';

setDefaultTimeout(360_000);

let fixture: Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;

beforeAll(async () => {
  fixture = await mediaRealmDownloadFixture();
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

function variant(image: NativeImage) {
  const selected = image.variants.find((entry) => entry.format === 'webp') ?? image.variants[0];
  if (!selected) throw new Error(`Native image ${image.id} produced no variants`);
  return { row: selected, name: `${selected.format}-${selected.width}` };
}

async function allowed(image: NativeImage, variantName: string, actor: MediaRealmPerson | null) {
  const result = await fixture.download(image.id, variantName, actor?.bearer ?? null);
  expect(result.response.status).toBe(200);
  const original = variantName === 'original';
  const expected = original ? undefined : variant(image).row;
  expect(result.value).toMatchObject({
    allowed: true,
    key: original ? `m/${image.id}/original` : expected!.key,
    sha256: original ? image.sha256 : expected!.sha256,
    byteCount: original ? image.bytes.byteLength : expected!.byteCount,
    publicCache: false,
  });
  expect(result.response.headers.get('cache-control')).toBe(original ? 'private, no-store' : 'private, no-store');
  return result;
}

async function absent(
  image: NativeImage,
  variantName: string,
  actor: MediaRealmPerson | null,
  headers: Record<string, string> = {},
) {
  const bearer = actor?.bearer ?? null;
  const unknown = await fixture.download(newId(routeOf(image.id)!), variantName, bearer, headers);
  const denied = await fixture.download(image.id, variantName, bearer, headers);
  expect(unknown.response.status).toBe(404);
  expect(denied.response.status).toBe(404);
  expect(normalizedProblem(denied.value)).toEqual(normalizedProblem(unknown.value));
  assertAbsentMetadata(denied.value, [image.sha256, ...image.variants.map((entry) => entry.sha256), `m/${image.id}/`]);
  return denied;
}

test('native protected Realm media downloads require current Realm read independently of board and media grants', async () => {
  const image = fixture.privateImage;
  const availableVariant = variant(image).name;

  const realmBefore = await fixture.readRealm(fixture.protectedRealm.realmId, fixture.alice.bearer);
  expect(realmBefore.response.status).toBe(200);
  await allowed(image, 'original', fixture.alice);
  await allowed(image, availableVariant, fixture.alice);
  await allowed(image, availableVariant, fixture.bob);
  await absent(image, 'original', fixture.bob);
  await absent(image, availableVariant, fixture.outsider);
  await absent(image, availableVariant, null);

  const publicRealmVariant = variant(fixture.publicRealmImage).name;
  const publicRealmReader = await fixture.download(fixture.publicRealmImage.id, publicRealmVariant, fixture.bob.bearer);
  expect(publicRealmReader.response.status).toBe(200);
  const publicRealmGrant = await fixture.db.admin.query(
    `SELECT count(*)::integer AS count FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND subject_role='' AND action='realm:read'
       AND valid @> clock_timestamp()`,
    [routeOf(fixture.publicRealm.realmId), fixture.publicRealm.realmId, fixture.bob.accountId],
  );
  expect(publicRealmGrant.rows[0]?.count).toBe(0);
  expect((await fixture.readRealm(fixture.publicRealm.realmId, fixture.bob.bearer)).response.status).toBe(200);

  const globalVariant = variant(fixture.globalImage).name;
  const globalPublic = await fixture.download(fixture.globalImage.id, globalVariant, null);
  expect(globalPublic.response.status).toBe(200);

  await fixture.revoke(fixture.protectedRealm.realmId, fixture.alice.accountId, ['realm:read']);
  const retained = await fixture.db.admin.query(
    `SELECT resource_id::text AS resource_id, action FROM access.resource_grant
     WHERE (resource_id=$1 OR resource_id=$2) AND subject_id=$3 AND subject_role='' AND action IN ('board:read','media:read')
       AND valid @> clock_timestamp() ORDER BY resource_id,action`,
    [fixture.protectedRealm.boardId, image.id, fixture.alice.accountId],
  );
  expect(retained.rows).toHaveLength(2);
  expect(retained.rows).toEqual(
    expect.arrayContaining([
      { resource_id: fixture.protectedRealm.boardId, action: 'board:read' },
      { resource_id: image.id, action: 'media:read' },
    ]),
  );
  expect((await fixture.readRealm(fixture.protectedRealm.realmId, fixture.alice.bearer)).response.status).toBe(404);
  await absent(image, 'original', fixture.alice, { 'if-none-match': `"${image.sha256}"` });
  await absent(image, availableVariant, fixture.alice, { 'if-none-match': `"${variant(image).row.sha256}"` });

  await fixture.grant(fixture.alice.accountId, fixture.protectedRealm.realmId, ['realm:read']);
  expect((await fixture.readRealm(fixture.protectedRealm.realmId, fixture.alice.bearer)).response.status).toBe(200);
  await allowed(image, 'original', fixture.alice);
  await allowed(image, availableVariant, fixture.alice);

  await fixture.checked(
    'PUT',
    `/v1/realms/${fixture.protectedRealm.realmId}/bans/${fixture.alice.accountId}`,
    { reason: 'Native media privacy regression' },
    200,
    { bearer: fixture.governor.bearer },
  );
  const retainedRealmGrant = await fixture.db.admin.query(
    `SELECT count(*)::integer AS count FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND subject_role='' AND action='realm:read'
       AND valid @> clock_timestamp()`,
    [routeOf(fixture.protectedRealm.realmId), fixture.protectedRealm.realmId, fixture.alice.accountId],
  );
  expect(retainedRealmGrant.rows[0]?.count).toBe(1);
  expect((await fixture.readRealm(fixture.protectedRealm.realmId, fixture.alice.bearer)).response.status).toBe(404);
  await absent(image, 'original', fixture.alice);
  await absent(image, availableVariant, fixture.alice, { 'if-none-match': `"${variant(image).row.sha256}"` });

  // A successful decision remains specific to its own current Realm and object.
  expect(
    (await fixture.download(fixture.publicRealmImage.id, publicRealmVariant, fixture.bob.bearer)).response.status,
  ).toBe(200);
  expect((await fixture.download(fixture.globalImage.id, globalVariant, null)).response.status).toBe(200);
});
