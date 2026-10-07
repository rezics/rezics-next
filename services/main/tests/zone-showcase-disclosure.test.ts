import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { slideIsCurrent, ZONE_SHOWCASE_DISCLOSURE_COST } from '../src/modules/zone/showcase-disclosure.ts';
import { bindZoneCampaignArtVariant, readZoneCampaignArt, requestNewZoneCampaignRenditions } from '../src/modules/zone/campaign-art.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MediaStore } from '../src/modules/media/store.ts';
import type { MediaDependencies } from '../src/modules/media/commands.ts';
import { MediaPresentationStore } from '../src/modules/media/presentation.ts';
import { withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';

const ref = () => `https://rezics.com/id/${randomUUID()}`;

test('public slide schedules include their start and exclude their end', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z');
  const slide = { id: 'launch', href: '/launch' };
  expect(slideIsCurrent(slide, now)).toBe(true);
  expect(slideIsCurrent({ ...slide, startsAt: new Date(now).toISOString() }, now)).toBe(true);
  expect(slideIsCurrent({ ...slide, endsAt: new Date(now).toISOString() }, now)).toBe(false);
  expect(slideIsCurrent({ ...slide, startsAt: new Date(now + 1).toISOString() }, now)).toBe(false);
  expect(ZONE_SHOWCASE_DISCLOSURE_COST).toMatchObject({ configurationReads: 5,
    maxHomeContentReads: 1, targetBatches: 1, maxTargets: 7 });
});

test('campaign disclosure hides a held Asset or Use before advertising source URLs or renditions', async () => {
  const realm = ref();
  const zone = ref();
  const asset = randomUUID();
  const use = randomUUID();
  const environment = { fuseki: { query: async () => ({ results: { bindings: [] } }) } } as unknown as WorkActivationEnvironment;
  let candidateReads = 0;
  const store = { itemDeliveryBatch: async () => new Map([[use, { asset, target: realm,
    availability: 'available', disclosure: 'public', moderation: 'none', lifecycle: 'active',
    width: 1280, height: 720, mediaType: 'image/png' }]]),
  renditions: { candidatesBatch: async () => { candidateReads++; return new Map(); } } } as unknown as MediaStore;
  const slides = [{ id: 'campaign', href: '/launch', title: 'Launch', art: { landscape: { use: `https://rezics.com/id/${use}` } } }];
  for (const held of [asset, use]) {
    configureDisclosure(environment, { read: async targets => {
      expect(targets).toHaveLength(2);
      expect(targets.every(target => target.context === 'urn:rezics:media:context:default')).toBe(true);
      return targets.map(target => target.resource.endsWith(held) ? 'hidden' : 'visible');
    } });
    expect(await readZoneCampaignArt(store, realm, slides, { environment, zone })).toEqual([
      { id: 'campaign', art: { landscape: null, portrait: null, cutout: null, logos: [] } },
    ]);
  }
  expect(candidateReads).toBe(0);
  expect(slides[0]!.title).toBe('Launch');
});

test('selected campaign art binds every original and rendition URL without mutating owner candidates', async () => {
  const realm = ref(), zone = ref(), asset = randomUUID(), use = randomUUID(), representation = randomUUID();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const environment = { fuseki: { query: async () => ({ results: { bindings: [] } }) } } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, { read: async targets => targets.map(() => 'visible') });
  const item = { asset, target: realm, representation, availability: 'available', disclosure: 'public',
    moderation: 'none', lifecycle: 'active', width: 1280, height: 720, mediaType: 'image/png' };
  const candidates = [
    { url: `/v1/media/representations/${randomUUID()}/bytes?use=${use}`, width: 320, height: 180, type: 'image/avif' as const },
    { url: `/v1/media/representations/${randomUUID()}/bytes?use=${use}`, width: 640, height: 360, type: 'image/webp' as const },
  ];
  const stored = JSON.stringify({ item, candidates });
  let itemReads = 0, candidateReads = 0;
  const store = { itemDeliveryBatch: async (uses: string[]) => {
    itemReads++;
    expect(uses).toEqual([use]);
    return new Map([[use, item]]);
  }, renditions: { candidatesBatch: async (uses: string[]) => {
    candidateReads++;
    expect(uses).toEqual([use]);
    return new Map([[use, candidates]]);
  } } } as unknown as MediaStore;
  const image = { use: `https://rezics.com/id/${use}` };
  const slides = [{ id: 'selected', href: '/selected', art: {
    landscape: image, portrait: image, cutout: image,
    logos: [{ ...image, language: 'fr', tone: 'light' as const, anchor: 'center-middle' as const }],
  } }];
  const originalSlides = JSON.stringify(slides);
  const legacy = await readZoneCampaignArt(store, realm, slides, { environment, zone });
  const selected = await readZoneCampaignArt(store, realm, slides, { environment, zone, variantId });
  const differentViewer = await withDisclosureViewer({ ...ANONYMOUS_VIEWER, signedIn: true },
    () => readZoneCampaignArt(store, realm, slides, { environment, zone, variantId }));
  expect(selected).toEqual(differentViewer);
  expect(bindZoneCampaignArtVariant(legacy, zone, variantId)).toEqual(selected);
  const art = selected[0]!.art;
  const images = [art.landscape!, art.portrait!, art.cutout!, ...art.logos];
  expect(images).toHaveLength(4);
  for (const resolved of images) {
    expect(resolved.url).toBe(`/v1/media/representations/${representation}/bytes?use=${use}&zone=${encodeURIComponent(zone)}&zoneVariant=${encodeURIComponent(variantId)}`);
    expect(resolved.srcset).toHaveLength(candidates.length);
    for (const [index, rendition] of resolved.srcset.entries()) {
      expect(rendition).toEqual({ ...candidates[index]!,
        url: `${candidates[index]!.url}&zone=${encodeURIComponent(zone)}&zoneVariant=${encodeURIComponent(variantId)}` });
    }
  }
  expect(legacy[0]!.art.landscape!.url)
    .toBe(`/v1/media/representations/${representation}/bytes?use=${use}`);
  expect(legacy[0]!.art.landscape!.srcset).toEqual(candidates);
  expect(JSON.stringify({ item, candidates })).toBe(stored);
  expect(JSON.stringify(slides)).toBe(originalSlides);
  expect(itemReads).toBe(3);
  expect(candidateReads).toBe(3);
});

test('post-commit rendition requests skip existing and dedicated campaign Uses and survive each storage failure', async () => {
  const realm = ref();
  const uses = Array.from({ length: 4 }, () => randomUUID());
  const inspected: string[] = [];
  let reads = 0;
  const media = { store: { itemDeliveryBatch: async () => {
    reads++;
    return new Map(uses.map((use, index) => [use, { target: realm, role: index === 1 ? 'campaign-cutout' : 'publication-item',
      availability: 'available', disclosure: 'public', moderation: 'none', lifecycle: 'active', width: 32, height: 32 }]));
  }, renditions: { requestBasis: async (use: string) => {
    inspected.push(use); return { namespace: 'media/', digest: '0'.repeat(64) };
  } } }, objects: () => ({ get: async () => { throw new Error('storage unavailable'); } }) } as unknown as MediaDependencies;
  const slides = uses.map((use, index) => ({ id: `slide-${index}`, href: '/', art: { cutout: { use: `https://rezics.com/id/${use}` } } }));
  await requestNewZoneCampaignRenditions(media, realm, slides, uses.slice(1));
  expect(inspected).toEqual(uses.slice(2));
  expect(reads).toBe(1);
  media.store.itemDeliveryBatch = async () => { throw new Error('Content unavailable'); };
  await requestNewZoneCampaignRenditions(media, realm, slides, uses.slice(1));
  await requestNewZoneCampaignRenditions(media, realm, slides, []);
});

test('derived rendition assessments retain source provenance and their own empty control basis', async () => {
  const representation = randomUUID();
  const source = randomUUID();
  const revision = randomUUID();
  const store = new MediaPresentationStore({ query: async () => ({ rows: [{ ordinality: 1,
    id: representation, asset_id: randomUUID(), byte_digest: 'a'.repeat(64), media_type: 'image/avif',
    pixel_width: 640, pixel_height: 360, byte_length: 100, owner: ref(), disclosure: 'public',
    object_namespace: 'media/', nsfw: 'sfw', nsfw_source_id: source, age_source_id: source,
    age_rating: { status: 'assessed', labels: ['r15'] }, assessed_revision: revision,
    age_created: new Date('2026-10-05T00:00:00.000Z'), age_predecessor: null,
  }] }) } as unknown as Pool);
  const metadata = (await store.metadata([{ representation }]))[0]!.metadata;
  expect(metadata).toMatchObject({ nsfw: 'sfw', nsfwSourceId: `https://rezics.com/id/${source}`,
    ageRating: { status: 'assessed', basis: 'source', sourceId: `https://rezics.com/id/${source}`,
      revision: `https://rezics.com/id/${revision}` } });
  expect(metadata.controls.nsfw.basis).toEqual({ head: null, epoch: '0', protection: null });
  expect(metadata.controls.nsfw.target.component).toBe(`https://rezics.com/id/${representation}`);
  expect(metadata.controls.ageRating.valueHead).toBeNull();
});
