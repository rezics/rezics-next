import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkZoneSitePublication, InvalidZoneConfiguration, ZONE_SITE_PUBLICATION_COST,
  zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';
import { publishZoneSite } from '../src/modules/zone/configuration.ts';
import { isZonePublishedPageRevision } from '../src/modules/zone/publication.ts';
import { openApiOperations } from '../src/routes/zones.ts';
import { rateLimitFamily } from '../src/modules/rate-limit/routes.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const ref = () => `https://rezics.com/id/${randomUUID()}`;
const page = () => ({ page: ref(), variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID() });
const selection = () => {
  const revision = ref();
  return { routesRevision: revision, navigationRevision: revision, pages: [page()] };
};

test('site publication selects exact bounded revisions and rejects duplicate variants or revisions', () => {
  const input = selection();
  expect(checkZoneSitePublication(input)).toEqual(input);
  for (const invalid of [
    { ...input, pages: [] },
    { ...input, pages: Array.from({ length: ZONE_SITE_PUBLICATION_COST.maxPages + 1 }, page) },
    { ...input, pages: [input.pages[0], input.pages[0]] },
    { ...input, pages: [input.pages[0], { ...page(), revisionId: input.pages[0]!.revisionId }] },
    { ...input, pages: [input.pages[0], { ...page(), variantId: input.pages[0]!.variantId }] },
    { ...input, pages: [{ ...page(), revisionId: 'draft-head' }] },
    { ...input, pages: [{ ...page(), variantId: 'foreign' }] },
    { ...input, pages: [{ ...page(), body: 'A second document store' }] },
  ]) expect(() => checkZoneSitePublication(invalid)).toThrow(InvalidZoneConfiguration);
  expect(checkZoneSitePublication({ ...input,
    pages: Array.from({ length: ZONE_SITE_PUBLICATION_COST.maxPages }, page) }).pages)
    .toHaveLength(ZONE_SITE_PUBLICATION_COST.maxPages);
});

test('malformed page selections fail before any admission or graph side effect', async () => {
  const unused = new Proxy({}, { get() { throw new Error('Invalid selection reached an owner'); } });
  await expect(publishZoneSite(unused as WorkActivationEnvironment,
    unused as Parameters<typeof publishZoneSite>[1], unused as Parameters<typeof publishZoneSite>[2],
    new Request('http://main.local'), { ...selection(), pages: [], zone: ref(), expectedHead: ref(),
      actingSubject: ref(), idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(InvalidZoneConfiguration);
  expect(await isZonePublishedPageRevision(unused as WorkActivationEnvironment, ref(), ref(), 'draft-head')).toBe(false);
});

test('membership keys distinguish Zone bundle, page and exact revision', () => {
  const bundle = ref(), other = ref(), saved = page();
  const key = zonePublishedPageBinding(bundle, saved.page, saved.revisionId);
  expect(zonePublishedPageBinding(bundle, saved.page, saved.revisionId)).toBe(key);
  expect(zonePublishedPageBinding(other, saved.page, saved.revisionId)).not.toBe(key);
  expect(zonePublishedPageBinding(bundle, other, saved.revisionId)).not.toBe(key);
  expect(zonePublishedPageBinding(bundle, saved.page, randomUUID())).not.toBe(key);
});

test('site publication is explicitly public, bearer authorized, idempotent and write limited', () => {
  expect(openApiOperations['/v1/zones/{id}/site-publications'].post).toEqual({
    rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true,
  });
  expect(rateLimitFamily('POST', '/v1/zones/{id}/site-publications')).toBe('write');
});
