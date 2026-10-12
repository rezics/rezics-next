import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { slideIsCurrent, ZONE_SHOWCASE_DISCLOSURE_COST } from '../src/modules/zone/showcase-disclosure.ts';
import { bindZoneCampaignArtVariant, readZoneCampaignArt, requestNewZoneCampaignRenditions } from '../src/modules/zone/campaign-art.ts';
import { configureDisclosure, configureDisclosureAncestrySource, type DisclosureTarget,
  type DisclosureAncestryEvidence, type DisclosureRelationshipBasis, type DisclosureReader } from '../src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MediaStore } from '../src/modules/media/store.ts';
import type { MediaDependencies } from '../src/modules/media/commands.ts';
import { MediaPresentationStore } from '../src/modules/media/presentation.ts';
import { withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { fixtureDisclosureReader, configureFixtureDisclosureAncestry } from './support/disclosure-ancestry.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const ref = () => `https://rezics.com/id/${randomUUID()}`;

/** Explicit fixture evidence for selected campaign media. Each Asset/Use pair
 * shares the same immutable Use receipt; only mounted art receives a Realm. */
function configureCampaignFixtureAncestry(env: WorkActivationEnvironment,
  realm?: { resource: string; head: string }) {
  const selected = new Map<string, DisclosureAncestryEvidence>();
  const evidence = (target: DisclosureTarget, use: string): DisclosureAncestryEvidence => {
    const relationshipBasis: DisclosureRelationshipBasis = {
      owner: 'media', kind: 'media-use', resource: use, revision: use,
      targetResource: target.resource, targetRevision: target.revision ?? null,
      token: createHash('sha256').update(JSON.stringify([use, realm])).digest('hex'),
      dataEpoch: env.lineage.dataEpoch,
    };
    const result: DisclosureAncestryEvidence = { resource: target.resource, resourceKind: 'other',
      relationshipBasis, status: 'complete', parents: realm ? [{ owner: 'graph', kind: 'realm',
        resource: realm.resource, head: realm.head, relationshipBasis: { ...relationshipBasis, kind: 'realm-placement' } }] : [] };
    selected.set(`${relationshipBasis.token}\0${target.resource}`, result);
    return result;
  };
  configureDisclosureAncestrySource(env, 'media', {
    read: async targets => targets.map((target, index) => evidence(target,
      target.component === 'cover' ? targets[index + 1]!.resource : target.resource)),
    reread: async bases => bases.map(basis => selected.get(`${basis.token}\0${basis.targetResource}`)!),
  });
}

function campaignFixtureEnvironment(realm?: { resource: string; head: string }): WorkActivationEnvironment {
  const env = { objectDirectory: '.temp/campaign-disclosure',
    lineage: { dataEpoch: 'campaign-fixture', routingEpoch: 'campaign-routing' },
    fuseki: { query: async () => ({ results: { bindings: realm ? [{ resource: { type: 'uri', value: realm.resource },
      head: { type: 'uri', value: realm.head } }] : [] } }) },
  } as unknown as WorkActivationEnvironment;
  configureCampaignFixtureAncestry(env, realm);
  return env;
}

function configureCampaignFixtureReader(env: WorkActivationEnvironment, read: DisclosureReader['read']) {
  configureDisclosure(env, fixtureDisclosureReader(read));
}

for (const audience of ['private', 'restricted'] as const) {
  for (const selectedVisible of [true, false]) {
    test(`campaign art ${selectedVisible ? 'renders its own image beside an unrelated' : 'withholds its own image despite another public'} ${audience} attachment`, async () => {
      const realm = ref(), otherTarget = ref(), zone = ref(), asset = randomUUID(), use = randomUUID(), otherUse = ref();
      const representation = randomUUID(), useRef = `https://rezics.com/id/${use}`, assetRef = `https://rezics.com/id/${asset}`;
      const environment = campaignFixtureEnvironment();
      const probes: string[][] = [], summaries: string[] = [];
      const privateTarget = selectedVisible ? otherTarget : realm;
      const uri = (value: string) => ({ type: 'uri', value });
      const literal = (value: string) => ({ type: 'literal', value });
      environment.fuseki.query = async query => {
        const refs = (variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
          .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
        if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
          const resources = refs('r');
          summaries.push(...resources);
          const control = { epoch: literal(environment.lineage.dataEpoch), sequence: literal('1') };
          return { results: { bindings: [control, ...resources.map(resource => ({ ...control,
            r: uri(resource), type: literal('work'), work: uri(resource), head: uri(resource),
            public: literal(String(audience !== 'private' || resource !== privateTarget)),
            label: { ...literal('Campaign'), 'xml:lang': 'en' } }))] } };
        }
        if (query.includes('SELECT ?resource ?head')) return { results: { bindings: refs('resource')
          .map(resource => ({ resource: uri(resource), head: uri(resource) })) } };
        if (query.includes('SELECT ?epoch ?hold ?context')) return { results: { bindings: [] } };
        throw new Error(`Unexpected campaign query: ${query.slice(0, 100)}`);
      };
      configureFixtureDisclosureAncestry(environment, target => ({ resource: target.work ?? target.resource,
        head: target.work ?? target.resource, ...(target.workRevision !== undefined
          ? { protectedRevision: target.workRevision } : {}) }));
      configureCampaignFixtureAncestry(environment);
      configureCampaignFixtureReader(environment, async targets => targets.map(target =>
        target.owner === 'graph' && target.resource === privateTarget && audience === 'restricted' ? 'hidden' : 'visible'));
      const facts = (targets: string[]) => ({ owner: ref(), disclosure: 'public', pending: false,
        blocked: false, attachmentOverflow: false,
        attachments: targets.map(target => ({ target, context: DEFAULT_MEDIA_CONTEXT })) });
      const inventory = new Map([[useRef, facts([realm])], [otherUse, facts([otherTarget])],
        [assetRef, facts([realm, otherTarget])]]);
      configureMediaVisibility({ environment, media: { store: {
        visibilityFacts: async (references: readonly string[]) => {
          probes.push([...references]);
          return new Map(references.map(reference => [reference, inventory.get(reference)!]));
        },
      } }, access: {} } as unknown as MainWorkDependencies);
      const store = { itemDeliveryBatch: async () => new Map([[use, { asset, representation, target: realm,
        role: 'publication-item', availability: 'available', disclosure: 'public', moderation: 'none',
        lifecycle: 'active', width: 1280, height: 720, mediaType: 'image/png' }]]),
      renditions: { candidatesBatch: async () => new Map() } } as unknown as MediaStore;
      const image = { use: useRef };
      const [result] = await readZoneCampaignArt(store, realm, [{ id: 'campaign', href: '/launch', art: {
        landscape: image, portrait: image, cutout: image,
        logos: [{ ...image, language: 'en', tone: 'light' as const, anchor: 'center-middle' as const }],
      } }], { environment, zone });
      if (selectedVisible) {
        const images = [result!.art.landscape, result!.art.portrait, result!.art.cutout, ...result!.art.logos];
        expect(images).toHaveLength(4);
        for (const rendered of images) expect(rendered?.url)
          .toBe(`/v1/media/representations/${representation}/bytes?use=${use}`);
      } else expect(result!.art).toEqual({ landscape: null, portrait: null, cutout: null, logos: [] });
      expect(probes).toEqual([[useRef], [useRef]]);
      expect(summaries).toEqual([realm, realm]);
    });
  }
}

test('campaign art fences a newly held Asset after rendition hydration', async () => {
  const realm = ref(), zone = ref(), asset = randomUUID(), use = randomUUID();
  const environment = campaignFixtureEnvironment();
  let held = false, candidateReads = 0;
  configureCampaignFixtureReader(environment, async targets => targets.map(target =>
    held && target.resource.endsWith(asset) ? 'hidden' : 'visible'));
  const store = { itemDeliveryBatch: async () => new Map([[use, { asset, target: realm,
    availability: 'available', disclosure: 'public', moderation: 'none', lifecycle: 'active',
    width: 1280, height: 720, mediaType: 'image/png' }]]),
  renditions: { candidatesBatch: async () => { candidateReads++; held = true; return new Map(); } } } as unknown as MediaStore;
  const [result] = await readZoneCampaignArt(store, realm,
    [{ id: 'campaign', href: '/launch', art: { landscape: { use: `https://rezics.com/id/${use}` } } }],
    { environment, zone });
  expect(result!.art.landscape).toBeNull();
  expect(candidateReads).toBe(1);
});

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
  const environment = campaignFixtureEnvironment();
  let candidateReads = 0;
  const store = { itemDeliveryBatch: async () => new Map([[use, { asset, target: realm,
    availability: 'available', disclosure: 'public', moderation: 'none', lifecycle: 'active',
    width: 1280, height: 720, mediaType: 'image/png' }]]),
  renditions: { candidatesBatch: async () => { candidateReads++; return new Map(); } } } as unknown as MediaStore;
  const slides = [{ id: 'campaign', href: '/launch', title: 'Launch', art: { landscape: { use: `https://rezics.com/id/${use}` } } }];
  for (const held of [asset, use]) {
    const checked: string[] = [];
    configureCampaignFixtureReader(environment, async targets => {
      expect(targets).toHaveLength(2);
      expect(targets.every(target => target.context === 'urn:rezics:media:context:default')).toBe(true);
      checked.push(...targets.map(target => target.resource));
      return targets.map(target => target.resource.endsWith(held) ? 'hidden' : 'visible');
    });
    expect(await readZoneCampaignArt(store, realm, slides, { environment, zone })).toEqual([
      { id: 'campaign', art: { landscape: null, portrait: null, cutout: null, logos: [] } },
    ]);
    expect(checked).toEqual([`https://rezics.com/id/${asset}`, `https://rezics.com/id/${use}`,
      `https://rezics.com/id/${asset}`, `https://rezics.com/id/${use}`]);
  }
  expect(candidateReads).toBe(0);
  expect(slides[0]!.title).toBe('Launch');
});

test('campaign art checks Asset and Use fences at the same policy cut', async () => {
  const realm = ref(), zone = ref(), asset = randomUUID(), use = randomUUID();
  const environment = campaignFixtureEnvironment();
  let policyReads = 0, candidateReads = 0;
  configureCampaignFixtureReader(environment, async targets => {
    // Each snapshot denies the image, even while the restriction moves.
    const held = policyReads++ % 2 === 0 ? use : asset;
    return targets.map(target => target.resource.endsWith(held) ? 'hidden' : 'visible');
  });
  const store = { itemDeliveryBatch: async () => new Map([[use, { asset, target: realm,
    availability: 'available', disclosure: 'public', moderation: 'none', lifecycle: 'active',
    width: 1280, height: 720, mediaType: 'image/png' }]]),
  renditions: { candidatesBatch: async () => { candidateReads++; return new Map(); } } } as unknown as MediaStore;
  expect(await readZoneCampaignArt(store, realm,
    [{ id: 'campaign', href: '/launch', art: { landscape: { use: `https://rezics.com/id/${use}` } } }],
    { environment, zone })).toEqual([
    { id: 'campaign', art: { landscape: null, portrait: null, cutout: null, logos: [] } },
  ]);
  expect(policyReads).toBe(2);
  expect(candidateReads).toBe(0);
});

for (const restrictedHead of ['historical', 'current'] as const) {
  test(`campaign art applies a Realm restriction only to its exact ${restrictedHead} parent revision`, async () => {
    const realm = ref(), zone = ref(), asset = randomUUID(), use = randomUUID(), representation = randomUUID();
    const historical = ref(), current = ref();
    const restricted = restrictedHead === 'historical' ? historical : current;
    const checked: DisclosureTarget[] = [];
    const environment = campaignFixtureEnvironment({ resource: realm, head: current });
    configureCampaignFixtureReader(environment, async targets => {
      checked.push(...targets);
      return targets.map(target => target.ancestry!.parents.some(parent => parent.kind === 'realm'
        && parent.resource === realm && parent.head === restricted) ? 'hidden' : 'visible');
    });
    let candidateReads = 0;
    const store = { itemDeliveryBatch: async () => new Map([[use, { asset, representation, target: realm,
      availability: 'available', disclosure: 'public', moderation: 'none', lifecycle: 'active',
      width: 1280, height: 720, mediaType: 'image/png' }]]),
    renditions: { candidatesBatch: async () => { candidateReads++; return new Map(); } } } as unknown as MediaStore;
    const result = await readZoneCampaignArt(store, realm,
      [{ id: 'campaign', href: '/launch', art: { landscape: { use: `https://rezics.com/id/${use}` } } }],
      { environment, zone });
    if (restrictedHead === 'historical') expect(result[0]!.art.landscape?.url)
      .toBe(`/v1/media/representations/${representation}/bytes?use=${use}`);
    else expect(result[0]!.art.landscape).toBeNull();
    expect(checked).toHaveLength(4);
    for (const target of checked) {
      expect(target.workRevision).toBeUndefined();
      expect(target.ancestry!.parents).toMatchObject([{ kind: 'realm', resource: realm, head: current }]);
      expect(target.ancestry!.relationshipBasis.resource).toBe(`https://rezics.com/id/${use}`);
    }
    expect(candidateReads).toBe(restrictedHead === 'historical' ? 1 : 0);
  });
}

test('a full campaign Use batch keeps each image policy together and filters the last held Use', async () => {
  const realm = ref(), zone = ref();
  const uses = Array.from({ length: 64 }, () => randomUUID());
  const assets = uses.map(() => randomUUID());
  const environment = campaignFixtureEnvironment();
  let policyReads = 0;
  configureCampaignFixtureReader(environment, async targets => {
    policyReads++;
    expect(targets).toHaveLength(64);
    for (let offset = 0; offset < targets.length; offset += 2) {
      expect(targets[offset]!.component).toBe('cover');
      expect(targets[offset + 1]!.component).toBe('media_use');
    }
    return targets.map(target => target.resource.endsWith(uses[63]!) ? 'hidden' : 'visible');
  });
  const store = { itemDeliveryBatch: async () => new Map(uses.map((use, index) => [use,
    { asset: assets[index], target: realm, availability: 'available', disclosure: 'public', moderation: 'none',
      lifecycle: 'active', width: 1280, height: 720, mediaType: 'image/png' }])),
  renditions: { candidatesBatch: async (selected: string[]) => {
    expect(selected).toEqual(uses.slice(0, -1)); return new Map();
  } } } as unknown as MediaStore;
  const languages = ['en', 'ja', 'zh', 'ko', 'de', 'fr', 'es', 'pt'];
  const slides = Array.from({ length: 6 }, (_, index) => ({ id: `campaign-${index}`, href: '/launch',
    art: { logos: uses.slice(index * 12, (index + 1) * 12).map((use, logo) => ({ use: `https://rezics.com/id/${use}`,
      language: languages[logo % 8]!, tone: logo < 8 ? 'light' as const : 'dark' as const,
      anchor: 'center-middle' as const })) } }));
  const result = await readZoneCampaignArt(store, realm, slides, { environment, zone });
  expect(result.flatMap(slide => slide.art.logos)).toHaveLength(63);
  expect(policyReads).toBe(4);
});

test('selected campaign art binds every original and rendition URL without mutating owner candidates', async () => {
  const realm = ref(), zone = ref(), asset = randomUUID(), use = randomUUID(), representation = randomUUID();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const environment = campaignFixtureEnvironment();
  configureCampaignFixtureReader(environment, async targets => targets.map(() => 'visible'));
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
