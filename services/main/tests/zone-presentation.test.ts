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

describe('zone-presentation-v1', () => {
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

  test('rejects missing sources, duplicate modules and empty banner schedules', () => {
    const module = { id: 'new-books', type: 'shelf', title: 'New books',
      source: { kind: 'query-block', block: 'missing' } };
    expect(() => checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION,
      modules: [module] }))).toThrow(InvalidZoneConfiguration);
    const fixed = { ...module, source: { kind: 'collection', collection: one } };
    expect(() => checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION,
      modules: [fixed, fixed] }))).toThrow('duplicate Zone module');
    expect(() => checkZoneConfiguration(configuration({ ...DEFAULT_ZONE_PRESENTATION,
      banners: [{ id: 'launch', title: 'Launch', alt: '', image: one, href: '/r/books',
        startsAt: '2026-09-29T00:00:00.000Z', endsAt: '2026-09-28T00:00:00.000Z' }] })))
      .toThrow('Zone banner schedule is empty');
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
      official: { routeSegment: 'fiction' },
    })))).toThrow('Official Zone needs a public default Realm');
  });
});
