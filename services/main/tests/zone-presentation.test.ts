import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { documentVersion, parseDocument } from '@rezics/document';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { hash, prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { compositionReceiptIri } from '../src/modules/structure/change.ts';
import { readZonePublication, readZonePublishedHomeContent } from '../src/modules/zone/publication.ts';
import { ZoneUnavailable, ZonePublicationUnavailable } from '../src/modules/zone/configuration.ts';
import { zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';
import { ZONE_LOCAL_SHOWCASE_BLOCK, zoneDocumentShowcase } from '../src/modules/presentation/zone-document.ts';
import { bindZoneCampaignReader, configureZoneShowcaseDisclosure, currentZoneCampaignUses }
  from '../src/modules/zone/showcase-disclosure.ts';
import { checkZoneConfiguration, InvalidZoneConfiguration, ZONE_CONFIG_FORMAT,
  ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PRESETS, ZONE_PRESENTATION_PROFILE, zoneRenderTokens, type ZonePresentation }
  from '../src/modules/zone/presentation-format.ts';

const id = (value: string) => `https://rezics.com/id/${value}`;
const one = id('00000000-0000-4000-8000-000000000001');
const two = id('00000000-0000-4000-8000-000000000002');
const three = id('00000000-0000-4000-8000-000000000003');

function configuration(presentation: unknown, queryBlocks: unknown[] = []) {
  return Buffer.from(JSON.stringify({ format: ZONE_CONFIG_FORMAT, zone: one, space: two,
    navigation: three, state: 'active', disclosure: 'public', presentation,
    budget: { timeMs: 2000, rows: 1000 }, queryBlocks, model: ZONE_PROFILE }));
}

describe('zone-presentation-v2', () => {
  test('accepts a bounded, typed layout and a matching query source', () => {
    const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION,
      modules: [{ id: 'new-books', type: 'shelf', title: 'New books',
        source: { kind: 'query-block', block: 'new-books' },
        tabs: [{ id: 'featured', label: 'Featured', source: { kind: 'collection', collection: one } }],
        options: { limit: 8, layout: 'covers' } }] };
    expect(checkZoneConfiguration(configuration(presentation, [
      { block: 'new-books', definition: two, maxRows: 8 },
    ])).presentation).toEqual(presentation);
  });

  test('rejects missing sources, duplicate modules and empty slide schedules', () => {
    const module = { id: 'new-books', type: 'shelf', title: 'New books',
      source: { kind: 'query-block', block: 'missing' } };
    expect(() => checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION,
      modules: [module] }))).toThrow(InvalidZoneConfiguration);
    const fixed = { ...module, source: { kind: 'collection', collection: one } };
    expect(() => checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION,
      modules: [fixed, fixed] }))).toThrow('duplicate Zone module');
    expect(() => checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION,
      slides: [{ id: 'launch', title: 'Launch', art: { landscape: { use: one, alt: '' } }, href: '/r/books',
        startsAt: '2026-09-29T00:00:00.000Z', endsAt: '2026-09-28T00:00:00.000Z' }] })))
      .toThrow('Zone slide schedule is empty');
  });

  test('presets derive a readable accent foreground', () => {
    for (const tokens of Object.values(ZONE_PRESETS)) {
      expect(['#000000', '#ffffff']).toContain(zoneRenderTokens(tokens).textOnAccent);
    }
    expect(zoneRenderTokens(ZONE_PRESETS.serial).textOnAccent).toBe('#000000');
  });

  test('an official marker requires a public Realm-backed Zone', () => {
    expect(() => checkZoneConfiguration(Buffer.from(JSON.stringify({
      ...JSON.parse(configuration(DEFAULT_ZONE_PRESENTATION).toString()),
      official: {},
    })))).toThrow('Official Zone needs a public default Realm');
  });
});

test('stored v1 banners become v2 slides without mutating the retained document', async () => {
  const { checkStoredZoneConfiguration } = await import('../src/modules/zone/config-format.ts');
  const { titleEffect: _effect, ...tokens } = DEFAULT_ZONE_PRESENTATION.tokens;
  const legacy = { ...DEFAULT_ZONE_PRESENTATION, profile: 'zone-presentation-v1', tokens,
    slides: undefined, banners: [{ id: 'launch', title: 'Launch', alt: 'Campaign art',
      image: one, href: '/r/books', startsAt: '2026-10-05T00:00:00.000Z' }] };
  const bytes = configuration(legacy);
  expect(checkStoredZoneConfiguration(bytes).presentation).toEqual({
    ...DEFAULT_ZONE_PRESENTATION, slides: [{ id: 'launch', title: 'Launch', href: '/r/books',
      startsAt: '2026-10-05T00:00:00.000Z', art: { landscape: { use: one, alt: 'Campaign art' } } }],
  });
  expect(JSON.parse(bytes.toString()).presentation.profile).toBe('zone-presentation-v1');
  expect(() => checkZoneConfiguration(bytes)).toThrow('Zone configuration format differs');
  expect(() => checkStoredZoneConfiguration(configuration({ ...legacy, unexpected: true })))
    .toThrow('Zone configuration format differs');
});

test('slides strictly validate targets, schedules, localized copy, logo slots and focal areas', () => {
  const slide = { id: 'launch', work: one, title: 'Launch', titles: { ja: '発売' },
    kicker: 'New', kickers: { fr: 'Nouveau' }, art: {
      landscape: { use: two, focalArea: 'xywh=percent:25,10,50,80' },
      logos: [{ use: three, language: 'zxx', tone: 'light' as const, anchor: 'center-middle' as const }],
    } };
  const document = { ...DEFAULT_ZONE_PRESENTATION, slides: [slide] };
  expect(checkZoneConfiguration(configuration(document)).presentation).toEqual(document);
  for (const invalid of [
    { ...slide, work: undefined }, { ...slide, href: '/r/books' },
    { ...slide, work: 'https://example.com/work' }, { ...slide, href: '//example.com', work: undefined },
    { ...slide, startsAt: '2026-10-05T00:00:00Z' },
    { ...slide, startsAt: '2026-10-05T00:00:00.000Z', endsAt: '2026-10-05T00:00:00.000Z' },
    { ...slide, titles: { ru: 'Unsupported title locale' } },
    { ...slide, art: { background: { use: two } } },
    { ...slide, art: { landscape: { use: two, focalArea: 'xywh=percent:80,0,30,100' } } },
    { ...slide, art: { cutout: { use: 'https://rezics.com/id/not-a-use' } } },
    { ...slide, art: { logos: [{ ...slide.art.logos[0], language: 'bad_language' }] } },
    { ...slide, art: { logos: [{ ...slide.art.logos[0], anchor: 'left' }] } },
    { ...slide, art: { logos: [{ ...slide.art.logos[0], tone: 'sepia' }] } },
  ]) {
    expect(() => checkZoneConfiguration(configuration({ ...document, slides: [invalid] })))
      .toThrow(InvalidZoneConfiguration);
  }
  expect(() => checkZoneConfiguration(configuration({ ...document, slides: [slide, slide] })))
    .toThrow('duplicate Zone slide');
  expect(() => checkZoneConfiguration(configuration({ ...document, slides: [{ ...slide,
    art: { logos: [{ use: two, language: 'en-US', tone: 'dark', anchor: 'center-top' },
      { use: three, language: 'EN-us', tone: 'dark', anchor: 'center-top' }] },
  }] }))).toThrow('duplicate Zone logo language and tone');
  expect(() => checkZoneConfiguration(configuration({ ...document, slides: Array(7).fill(slide) })))
    .toThrow(InvalidZoneConfiguration);
  expect(() => checkZoneConfiguration(configuration({ ...document,
    tokens: { ...document.tokens, titleEffect: 'animation' } }))).toThrow(InvalidZoneConfiguration);
});

test('campaign art across slides fits one 64-Use rendition batch', () => {
  const slides = Array.from({ length: 6 }, (_, index) => ({ id: `slide-${index}`, href: '/',
    art: { logos: Array.from({ length: 11 }, (_, logo) => ({
      use: id(`00000000-0000-4000-8000-${String(index * 11 + logo).padStart(12, '0')}`),
      language: `en-x-logo${logo}`, tone: 'dark' as const, anchor: 'center-top' as const,
    })) },
  }));
  expect(() => checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION, slides })))
    .toThrow('Zone campaign art exceeds its Use batch bound');
  slides[5]!.art.logos.splice(9);
  expect(checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION, slides })).presentation)
    .toEqual({ ...DEFAULT_ZONE_PRESENTATION, slides });
});

/** Actual immutable Zone readers with only the graph/Content owner replaced.
 * No module mocking: the other owner suites keep their ordinary route bindings. */
function publishedHomeFixture() {
  const directory = mkdtempSync('.temp/zone-campaign-home-');
  const zone = one, realm = id(randomUUID()), revision = id(randomUUID());
  const presentation = { ...DEFAULT_ZONE_PRESENTATION,
    slides: [{ id: 'configuration', href: '/configuration', art: { landscape: { use: two } } }] };
  const config = { ...JSON.parse(configuration(presentation).toString()), defaultRealm: realm };
  const manifest = `urn:rezics:sha256:${prepareComponent(directory, zone,
    { configuration: config, name: 'Selected home', language: 'en' }, ZONE_PROFILE)}`;
  const admissionId = randomUUID(), receipt = compositionReceiptIri(admissionId, 'zone.edit');
  const pages = ['en', 'ja'].map(language => ({ page: zone,
    variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID(), language }));
  const draft = { page: zone, variantId: `urn:rezics:variant:${randomUUID()}`,
    revisionId: randomUUID(), language: 'ja' };
  const document = parseDocument({ version: documentVersion, profile: 'blocks', doc: { type: 'doc',
    content: [{ type: 'extensionBlock', attrs: { id: 'curated',
      definition: ZONE_LOCAL_SHOWCASE_BLOCK.definition, version: ZONE_LOCAL_SHOWCASE_BLOCK.version,
      fallback: 'Retained fallback', payload: {
        'rv:module': [{ id: 'hero', type: 'hero-carousel', title: 'Exact Content',
          source: { kind: 'query-block', block: 'new-adoptions' } }],
        'rv:slides': [{ id: 'content', href: '/content', art: { landscape: { use: three } } }],
        'rv:titleEffect': ['outline'],
      } } }] } });
  const body = { document }, serializedJson = JSON.stringify(body), byteDigest = hash(serializedJson);
  const mutable = { membership: true, erased: false, metadataAvailable: true,
    metadataDigest: byteDigest, returnedVariant: '', returnedResource: '', contentStatus: 'available' };
  const reads: string[][] = [], membershipQueries: string[] = [];
  const term = (value: string) => ({ type: 'uri' as const, value });
  const row = (values: Record<string, string>) => Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, term(value)]));
  const environment = { objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    addresses: { currents: async () => new Map() }, fuseki: { query: async (query: string) => {
      if (query.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [row({
        space: two, navigation: three, head: revision, manifest, state: `${RV}Active`,
        disclosure: `${RV}Public`, spaceDisclosure: `${RV}Public`, realm,
        presentation: ZONE_PRESENTATION_PROFILE, publication: revision,
      })] } };
      if (query.includes('SELECT ?receipt')) return { results: { bindings: [{ receipt: term(receipt) }] } };
      if (query.includes('SELECT ?zone ?revision ?routesRevision')) return { results: { bindings:
        pages.map(page => row({ zone, revision, routesRevision: revision, navigationRevision: revision,
          themeRevision: revision, count: String(pages.length), admissionId, digest: 'a'.repeat(64),
          authorityEpoch: 'authority', scope: `zone:edit:${zone}`, dataEpoch: 'epoch', sequence: '1',
          binding: zonePublishedPageBinding(revision, zone, page.revisionId), page: zone,
          variant: page.variantId, contentRevision: `urn:rezics:content:revision:${page.revisionId}`,
          language: page.language })) } };
      if (query.includes('SELECT ?manifest')) return { results: { bindings: [{ manifest: term(manifest) }] } };
      if (query.includes('SELECT ?target')) return { results: { bindings: mutable.erased
        ? [{ target: term(`urn:rezics:content:revision:${reads.at(-1)![0]}`) }] : [] } };
      if (query.includes('rv:admittedScope') && query.includes('ASK')) {
        membershipQueries.push(query);
        return { boolean: mutable.membership };
      }
      if (query.includes('ASK')) return { boolean: true };
      throw new Error(`Unexpected home owner query: ${query}`);
    } } } as unknown as WorkActivationEnvironment;
  const content = { readExactBatch: async (ids: string[], authorize: Parameters<ContentCore['readExactBatch']>[1]) => {
    reads.push([...ids]);
    expect(await authorize(ids)).toEqual(new Set(ids));
    const page = [...pages, draft].find(candidate => candidate.revisionId === ids[0])!;
    if (mutable.contentStatus !== 'available') return [{ revisionId: page.revisionId, status: 'erased' }];
    return [{ status: 'available', revisionId: page.revisionId, body, serializedJson,
      reference: { owner: 'content', resourceId: mutable.returnedResource || zone,
        variantId: mutable.returnedVariant || page.variantId, revisionId: page.revisionId,
        format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest,
        byteLength: Buffer.byteLength(serializedJson), direction: 'ltr',
        language: { kind: 'tag', tag: page.language, originalTag: page.language },
        sourceRevision: null, predecessor: null, provenance: {} } }] satisfies ExactReadResult[];
  } };
  const work = { environment, content, contentAuthoring: { readExactMetadataBatch: async (ids: string[]) =>
    new Map(ids.map(revisionId => [revisionId, { availability: mutable.metadataAvailable ? 'available' : 'erased',
      byteDigest: mutable.metadataDigest }])) } } as unknown as MainWorkDependencies;
  return { work, pages, draft, mutable, reads, membershipQueries, serializedJson, zone, realm,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('published home selects one exact language revision and preserves Content-local choices', async () => {
  const f = publishedHomeFixture();
  try {
    const state = await readZonePublication(f.work.environment, f.zone);
    const home = await readZonePublishedHomeContent(f.work, state, ['ja']);
    expect(f.reads).toEqual([[f.pages[1]!.revisionId]]);
    expect(home!.page).toEqual(f.pages[1]!);
    expect(home!.reference.variantId).toBe(f.pages[1]!.variantId);
    expect(zoneDocumentShowcase(home!.document)!.payload['rv:slides'])
      .toEqual([{ id: 'content', href: '/content', art: { landscape: { use: three } } }]);
    expect(state.presentation.slides[0]!.art!.landscape!.use).toBe(two);
    expect(JSON.stringify({ document: home!.document })).toBe(f.serializedJson);
    expect(f.membershipQueries).toHaveLength(2);
    for (const query of f.membershipQueries) expect(query)
      .toContain(`rv:contentRevision <urn:rezics:content:revision:${f.pages[1]!.revisionId}>`);
  } finally { f.close(); }
});

test('explicit published home variant selects the exact revision despite a different browser language', async () => {
  const f = publishedHomeFixture();
  try {
    const state = await readZonePublication(f.work.environment, f.zone);
    const selected = f.pages[1]!;
    const home = await readZonePublishedHomeContent(f.work, state, ['en'], selected.variantId);
    expect(home!.page).toEqual(selected);
    expect(home!.reference.variantId).toBe(selected.variantId);
    expect(f.reads).toEqual([[selected.revisionId]]);
    expect(JSON.stringify({ document: home!.document })).toBe(f.serializedJson);
    expect(f.membershipQueries).toHaveLength(2);
    for (const query of f.membershipQueries) expect(query)
      .toContain(`rv:contentRevision <urn:rezics:content:revision:${selected.revisionId}>`);
  } finally { f.close(); }
});

for (const selection of ['unknown', 'draft-only', 'other-page', 'removed-variant'] as const) {
  test(`explicit ${selection} variant denies without reading a fallback Content revision`, async () => {
    const f = publishedHomeFixture();
    try {
      const state = await readZonePublication(f.work.environment, f.zone);
      let variantId = `urn:rezics:variant:${randomUUID()}`;
      if (selection === 'draft-only') {
        // An owner draft identifier is not membership in the immutable public bundle.
        variantId = f.draft.variantId;
      }
      if (selection === 'other-page') {
        state.bundle!.pages.push({ ...f.pages[1]!, page: f.realm, variantId });
      }
      if (selection === 'removed-variant') {
        variantId = f.pages[1]!.variantId;
        state.bundle!.pages = state.bundle!.pages.filter(page => page.variantId !== variantId);
      }
      await expect(readZonePublishedHomeContent(f.work, state, ['en'], variantId))
        .rejects.toBeInstanceOf(ZoneUnavailable);
      expect(f.reads).toEqual([]);
      expect(f.membershipQueries).toEqual([]);
    } finally { f.close(); }
  });
}

test('explicit variant cannot turn a configuration-only publication into a Content selection', async () => {
  const f = publishedHomeFixture();
  try {
    const state = { ...await readZonePublication(f.work.environment, f.zone), bundle: null };
    expect(await readZonePublishedHomeContent(f.work, state, ['en'])).toBeNull();
    await expect(readZonePublishedHomeContent(f.work, state, ['en'], f.pages[1]!.variantId))
      .rejects.toBeInstanceOf(ZoneUnavailable);
    expect(f.reads).toEqual([]);
    expect(f.membershipQueries).toEqual([]);
  } finally { f.close(); }
});

test('published bundle without Content owner denies exact home and campaign config fallback', async () => {
  const f = publishedHomeFixture();
  try {
    const state = await readZonePublication(f.work.environment, f.zone);
    await expect(readZonePublishedHomeContent({ environment: f.work.environment }, state))
      .rejects.toBeInstanceOf(ZonePublicationUnavailable);
    expect(await currentZoneCampaignUses(f.work.environment, f.zone, {}, f.realm)).toEqual(new Set());
    expect(f.reads).toEqual([]);
  } finally { f.close(); }
});

test('campaign exact Content selection keeps the renderer language preference through reader composition', async () => {
  const f = publishedHomeFixture();
  try {
    configureZoneShowcaseDisclosure(f.work);
    // readerFor composes by object spread; the request binding must survive it.
    const reader = { ...bindZoneCampaignReader({}, new Request('https://main.test/media', {
      headers: { 'x-rezics-display-languages': 'ja,en', 'accept-language': 'en' },
    })) };
    f.mutable.contentStatus = 'erased';
    expect(await currentZoneCampaignUses(f.work.environment, f.zone, reader, f.realm)).toEqual(new Set());
    expect(f.reads).toEqual([[f.pages[1]!.revisionId]]);
    expect(f.membershipQueries).toHaveLength(1);
  } finally { f.close(); }
});

test('campaign URL variant survives reader composition and overrides browser English', async () => {
  const f = publishedHomeFixture();
  try {
    configureZoneShowcaseDisclosure(f.work);
    const reader = { ...bindZoneCampaignReader({}, new Request(
      `https://main.test/media?zone=${encodeURIComponent(f.zone)}&zoneVariant=${encodeURIComponent(f.pages[1]!.variantId)}`, {
        headers: { 'accept-language': 'en' },
      })) };
    f.mutable.contentStatus = 'erased';
    expect(await currentZoneCampaignUses(f.work.environment, f.zone, reader, f.realm)).toEqual(new Set());
    expect(f.reads).toEqual([[f.pages[1]!.revisionId]]);
    expect(f.membershipQueries).toHaveLength(1);
  } finally { f.close(); }
});

test('unknown campaign URL variant denies before reading either language or configuration art', async () => {
  const f = publishedHomeFixture();
  try {
    configureZoneShowcaseDisclosure(f.work);
    const reader = { ...bindZoneCampaignReader({}, new Request(
      `https://main.test/media?zone=${encodeURIComponent(f.zone)}&zoneVariant=${encodeURIComponent(`urn:rezics:variant:${randomUUID()}`)}`, {
        headers: { 'accept-language': 'en' },
      })) };
    expect(await currentZoneCampaignUses(f.work.environment, f.zone, reader, f.realm)).toEqual(new Set());
    expect(f.reads).toEqual([]);
    expect(f.membershipQueries).toEqual([]);
  } finally { f.close(); }
});

for (const failure of ['wrong-variant', 'wrong-resource', 'content-erased', 'graph-erased',
  'metadata-erased', 'metadata-digest', 'publication-moved'] as const) {
  test(`published home fails closed after ${failure}`, async () => {
    const f = publishedHomeFixture();
    try {
      const state = await readZonePublication(f.work.environment, f.zone);
      if (failure === 'wrong-variant') f.mutable.returnedVariant = `urn:rezics:variant:${randomUUID()}`;
      if (failure === 'wrong-resource') f.mutable.returnedResource = id(randomUUID());
      if (failure === 'content-erased') f.mutable.contentStatus = 'erased';
      if (failure === 'graph-erased') f.mutable.erased = true;
      if (failure === 'metadata-erased') f.mutable.metadataAvailable = false;
      if (failure === 'metadata-digest') f.mutable.metadataDigest = 'b'.repeat(64);
      if (failure === 'publication-moved') {
        const original = f.work.content!.readExactBatch.bind(f.work.content);
        f.work.content!.readExactBatch = async (...args) => {
          const result = await original(...args);
          f.mutable.membership = false;
          return result;
        };
      }
      await expect(readZonePublishedHomeContent(f.work, state)).rejects.toBeInstanceOf(ZoneUnavailable);
      expect(f.reads).toHaveLength(1);
      expect(f.reads[0]).toHaveLength(1);
    } finally { f.close(); }
  });
}
