import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { slideIsCurrent, ZONE_SHOWCASE_DISCLOSURE_COST } from '../src/modules/zone/showcase-disclosure.ts';
import { readZoneCampaignArt, requestNewZoneCampaignRenditions } from '../src/modules/zone/campaign-art.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MediaStore } from '../src/modules/media/store.ts';
import type { MediaDependencies } from '../src/modules/media/commands.ts';
import { MediaPresentationStore } from '../src/modules/media/presentation.ts';

const ref = () => `https://rezics.com/id/${randomUUID()}`;

test('public slide schedules include their start and exclude their end', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z');
  const slide = { id: 'launch', href: '/launch' };
  expect(slideIsCurrent(slide, now)).toBe(true);
  expect(slideIsCurrent({ ...slide, startsAt: new Date(now).toISOString() }, now)).toBe(true);
  expect(slideIsCurrent({ ...slide, endsAt: new Date(now).toISOString() }, now)).toBe(false);
  expect(slideIsCurrent({ ...slide, startsAt: new Date(now + 1).toISOString() }, now)).toBe(false);
  expect(ZONE_SHOWCASE_DISCLOSURE_COST).toMatchObject({ configurationReads: 1, targetBatches: 1, maxTargets: 7 });
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
