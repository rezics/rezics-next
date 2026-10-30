import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { ProblemError } from '../../src/http/problem.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { DocumentMediaPage } from '../../src/content/media-presentation.ts';
import { DocumentMediaInputSchema, DocumentMediaPageSchema } from '../../src/content/schemas.ts';
import candidates from '../../src/content/media-presentation.sql';
import derivative from '../../src/content/read-download-media.sql';
import { mediaRealmDownloadFixture } from './media-realm-download-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(360_000);
let fixture: Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;
beforeAll(async () => { fixture = await mediaRealmDownloadFixture(); }, 240_000);
afterAll(async () => { await fixture?.close(); });

async function page(ids: readonly string[], bearer: string | null) {
  return fixture.call('POST', '/v1/media/presentations', { body: { ids }, bearer });
}

function images(value: Record<string, unknown>): DocumentMediaPage['images'] {
  expect(Compile(DocumentMediaPageSchema).Check(value)).toBe(true);
  return (value as DocumentMediaPage).images;
}

test('Current authorized native image derivative presentation for actual document readers', async () => {
  const { globalImage, privateImage, bob, outsider } = fixture;
  const missing = newId(routeOf(globalImage.id)!);
  const publicPage = await page([globalImage.id, privateImage.id, missing], null);
  expect(publicPage.response.status).toBe(200);
  expect(publicPage.response.headers.get('cache-control')).toBe('private, no-store');
  const publicImages = images(publicPage.value);
  expect(publicImages).toHaveLength(1);
  const image = publicImages[0]!;
  expect(image).toMatchObject({ id: globalImage.id, digest: globalImage.sha256, width: 64, height: 64, credit: null });
  expect(Object.keys(image).sort()).toEqual([
    'id', 'containerId', 'digest', 'width', 'height', 'variants', 'placeholder', 'focalPoint', 'credit',
  ].sort());
  const stored = await fixture.db.admin.query<{ format: 'avif' | 'webp'; width: number; height: number }>(
    'SELECT format,width,height FROM content.media_variant WHERE route=$1 AND media_id=$2',
    [routeOf(globalImage.id), globalImage.id],
  );
  expect(image.variants.length).toBeGreaterThan(0);
  for (const variant of image.variants) {
    expect(stored.rows).toContainEqual(variant);
    expect((await fixture.download(globalImage.id, `${variant.format}-${variant.width}`, null)).response.status).toBe(200);
  }
  expect(JSON.stringify(publicPage.value)).not.toMatch(/"(?:key|url|uploaderId|reservationRequestId|body)"\s*:/);
  const allowed = await page([privateImage.id], bob.bearer);
  expect(allowed.response.status).toBe(200);
  expect(images(allowed.value).map((entry) => entry.id)).toEqual([privateImage.id]);
  // An ordinary document reader cannot use the uploader-only reservation surface.
  expect((await fixture.call('GET', `/v1/media/${privateImage.id}`, { bearer: bob.bearer })).response.status).toBe(404);
  const denied = await page([privateImage.id, missing], outsider.bearer);
  expect(denied.response.status).toBe(200);
  expect(denied.value).toEqual({ images: [] });
  await fixture.revoke(fixture.protectedRealm.realmId, bob.accountId, ['realm:read']);
  try {
    expect((await page([privateImage.id], bob.bearer)).value).toEqual({ images: [] });
    expect((await fixture.download(privateImage.id, `${image.variants[0]!.format}-64`, bob.bearer)).response.status).toBe(404);
  } finally {
    await fixture.grant(bob.accountId, fixture.protectedRealm.realmId, ['realm:read']);
  }
  await fixture.checked('PUT', `/v1/realms/${fixture.protectedRealm.realmId}/bans/${bob.accountId}`,
    { reason: 'Current image reader privacy' }, 200);
  expect((await page([privateImage.id], bob.bearer)).value).toEqual({ images: [] });
});

test('presentation input and page are closed, bounded and reject transport fields', async () => {
  const id = fixture.globalImage.id;
  const input = Compile(DocumentMediaInputSchema);
  for (const body of [
    { ids: [] }, { ids: [id, id] }, { ids: [newId(1), 'not-routed'] }, { ids: [`${id}\n`] },
    { ids: Array.from({ length: 33 }, () => newId(1)) }, { ids: [id], containerId: id },
  ]) {
    expect(input.Check(body)).toBe(false);
    const result = await fixture.call('POST', '/v1/media/presentations', { body, bearer: null });
    expect(result.response.status).toBe(400);
    expect(result.value.code).toBe('invalid_request');
  }
  const result = await page([id], null);
  const image = images(result.value)[0]!;
  const pageSchema = Compile(DocumentMediaPageSchema);
  expect(pageSchema.Check({ images: [{ ...image, key: `m/${id}/original` }] })).toBe(false);
  expect(pageSchema.Check({ images: [{ ...image, variants: [{ ...image.variants[0], url: '/guessed' }] }] })).toBe(false);
});

test('native final derivative changes withhold without refill and typed unavailability stays an error', async () => {
  const image = fixture.globalImage;
  const observer = observeSql(fixture.db.pool);
  const barrier = observer.hold({ statement: derivative.sql }, 'after');
  const pending = page([image.id], null);
  let selected: { format: string; width: number; height: number } | undefined;
  try {
    const execution = await barrier.entered;
    const parameters = execution.parameters;
    selected = (await fixture.db.admin.query<{ format: string; width: number; height: number }>(
      'SELECT format,width,height FROM content.media_variant WHERE route=$1 AND media_id=$2 AND format=$3 AND width=$4',
      [routeOf(image.id), image.id, parameters[derivative.params.indexOf('format')], parameters[derivative.params.indexOf('width')]],
    )).rows[0]!;
    await fixture.db.admin.query(
      'UPDATE content.media_variant SET height=height+1 WHERE route=$1 AND media_id=$2 AND format=$3 AND width=$4',
      [routeOf(image.id), image.id, selected.format, selected.width],
    );
    barrier.release();
    const changed = await pending;
    expect(changed.response.status).toBe(200);
    expect(changed.value).toEqual({ images: [] });
  } finally {
    barrier.release();
    await pending;
    await observer.close();
    if (selected) await fixture.db.admin.query(
      'UPDATE content.media_variant SET height=$5 WHERE route=$1 AND media_id=$2 AND format=$3 AND width=$4',
      [routeOf(image.id), image.id, selected.format, selected.width, selected.height],
    );
  }
  const outage = observeSql(fixture.db.pool);
  outage.armFault({ match: { statement: candidates.sql }, boundary: 'before', error: new ProblemError('partition_unavailable') });
  try {
    const unavailable = await page([image.id], null);
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.value.code).toBe('partition_unavailable');
    expect(unavailable.value).not.toHaveProperty('images');
    expect(JSON.stringify(unavailable.value)).not.toContain(image.sha256);
  } finally { await outage.close(); }
});
