import { describe, expect, test } from 'bun:test';
import { checkZoneConfiguration, InvalidZoneConfiguration, ZONE_CONFIG_FORMAT,
  ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PRESETS, zoneRenderTokens, type ZonePresentation }
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
