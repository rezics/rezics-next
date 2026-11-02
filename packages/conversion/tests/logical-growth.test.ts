import { expect, test } from 'bun:test';
import type { ConversionInput } from '../src/index.ts';
import { convertBangumi, converter_revision as bangumiRevision } from '../src/bangumi.ts';
import { convertVndb, converter_revision as vndbRevision, vndbLimits } from '../src/vndb.ts';
import { convertWikidata, converter_revision as wikidataRevision, wikidataLimits } from '../src/wikidata.ts';
import { convertOpenLibrary, converter_revision as openLibraryRevision } from '../src/open-library.ts';

const context = { subjectId: '00000000-0000-4000-8000-000000000001' };

// Each generator varies only accepted native text, with a fixed collection shape.
// Non-ASCII text makes the measurement explicitly UTF-8, rather than JS length.
function bangumiSeed(size: number, id: number): ConversionInput {
  return {
    external_id: String(id),
    record_revision: '7',
    record: { id, type: 1, name: 'Book', infobox: 'é'.repeat(size) },
  };
}
function vndbSeed(size: number, key: number): ConversionInput {
  const id = `v${key}`;
  return {
    external_id: id,
    record_revision: '7',
    record: {
      vn: { id, olang: 'en', alias: 'Community alternate name' },
      entry_meta: { id, revision: 7 },
      vn_titles: Array.from({ length: 32 }, (_, i) => ({
        id,
        lang: `en-x-t${i}`,
        official: true,
        title: 'é'.repeat(size),
        latin: null,
      })),
    },
  };
}
function wikidataSeed(size: number, key: number): ConversionInput {
  const id = `Q${key}`;
  return {
    external_id: id,
    record_revision: '7',
    record: {
      id,
      type: 'item',
      lastrevid: 7,
      labels: { en: { language: 'en', value: 'Mapo tofu' } },
      aliases: {
        en: Array.from({ length: 60 }, (_, i) => ({ language: 'en', value: `${i}-${'é'.repeat(size)}` })),
      },
      descriptions: {},
      claims: {
        P31: [
          {
            type: 'statement',
            rank: 'normal',
            mainsnak: {
              property: 'P31',
              snaktype: 'value',
              datatype: 'wikibase-item',
              datavalue: {
                type: 'wikibase-entityid',
                value: { 'entity-type': 'item', 'numeric-id': 746549, id: 'Q746549' },
              },
            },
          },
        ],
      },
    },
  };
}
function openLibrarySeed(size: number, id: number): ConversionInput {
  const key = `/works/OL${id}W`;
  return {
    external_id: key,
    record_revision: '7',
    record: {
      type: { key: '/type/work' },
      key,
      revision: 7,
      last_modified: { type: '/type/datetime', value: '2025-01-02T03:04:05.123456' },
      title: 'Book',
      description: 'é'.repeat(size),
    },
  };
}

const sources = [
  // normalize: 64 KiB projection, infobox <=65,536 characters.
  {
    name: 'Bangumi',
    convert: convertBangumi,
    revision: bangumiRevision,
    seed: bangumiSeed,
    sizes: [3000, 15000, 31000],
    cap: 65_536,
  },
  // project: 64 KiB projection, <=64 titles, each <=1500 code points/4096 bytes.
  {
    name: 'VNDB',
    convert: convertVndb,
    revision: vndbRevision,
    seed: vndbSeed,
    sizes: [100, 400, 900],
    cap: vndbLimits.recordBytes,
  },
  // <=64 total terms, <=1500 characters each, 128 KiB entire record.
  {
    name: 'Wikidata',
    convert: convertWikidata,
    revision: wikidataRevision,
    seed: wikidataSeed,
    sizes: [100, 400, 1000],
    cap: wikidataLimits.bytes,
  },
  // normalize: prose <=1 MiB, within the platform hard record bound as well.
  {
    name: 'Open Library',
    convert: convertOpenLibrary,
    revision: openLibraryRevision,
    seed: openLibrarySeed,
    sizes: [32_000, 128_000, 500_000],
    cap: 1024 * 1024,
  },
];

function trackSourceGraph(value: unknown, tracked: WeakSet<object>, visited = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  tracked.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) trackSourceGraph(descriptor.value, tracked, visited);
  }
}

function sourceFieldVisits(inputs: ConversionInput[], convert: (input: ConversionInput) => void): number {
  const tracked = new WeakSet<object>();
  for (const input of inputs) trackSourceGraph(input, tracked);

  let visits = 0;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const keys = Object.keys;
  const hasOwn = Object.hasOwn;
  const count = (target: object) => {
    if (tracked.has(target)) visits++;
  };
  Object.getOwnPropertyDescriptor = (target, key) => {
    count(target);
    return getOwnPropertyDescriptor(target, key);
  };
  Object.keys = (target) => {
    const names = keys(target);
    if (tracked.has(target)) visits += names.length;
    return names;
  };
  Object.hasOwn = (target, key) => {
    count(target);
    return hasOwn(target, key);
  };
  try {
    for (const input of inputs) convert(input);
  } finally {
    Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
    Object.keys = keys;
    Object.hasOwn = hasOwn;
  }
  return visits;
}

for (const source of sources) {
  test(`${source.name}: actual unrelated conversions leave anchor return bytes identical`, () => {
    const options = { converterRevision: source.revision };
    const anchor = source.seed(source.sizes[0]!, 1);
    const before = Buffer.from(JSON.stringify(source.convert(anchor, context, options)), 'utf8');
    const n = 8;
    let nextKey = 2;
    for (const scale of [1, 8, 64]) {
      for (let i = 0; i < scale * n; i++) {
        // Stream distinct valid keys through the same actual exported function.
        const unrelated = source.convert(source.seed(1, nextKey++), context, options);
        expect(unrelated.external_id).not.toBe(anchor.external_id);
        expect(unrelated.proposals.length).toBeGreaterThan(0);
      }
      const after = Buffer.from(JSON.stringify(source.convert(anchor, context, options)), 'utf8');
      expect(after).toEqual(before);
    }
  });

  test(`${source.name}: whole-return logical bytes have at most linear incremental slopes`, () => {
    const samples = source.sizes.map((size) => {
      const input = source.seed(size, 1);
      const output = source.convert(input, context, { converterRevision: source.revision });
      expect(output.proposals.length).toBeGreaterThan(0);
      return {
        inputBytes: Buffer.byteLength(JSON.stringify(input.record), 'utf8'),
        // Include every returned field, including normalized hash input, diagnostics,
        // metadata, proposals and assets; no projection to command bytes or metrics.
        returnBytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      };
    });
    expect(samples).toHaveLength(3);
    const slopes: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      expect(sample.inputBytes).toBeLessThanOrEqual(source.cap);
      expect(sample.returnBytes).toBeGreaterThan(0);
      if (i === 0) continue;
      const previous = samples[i - 1]!;
      expect(sample.inputBytes).toBeGreaterThan(previous.inputBytes);
      expect(sample.returnBytes).toBeGreaterThan(previous.returnBytes);
      slopes.push((sample.returnBytes - previous.returnBytes) / (sample.inputBytes - previous.inputBytes));
    }
    expect(samples[2]!.inputBytes).toBeGreaterThan(source.cap * 0.9);
    expect(slopes[0]!).toBeLessThanOrEqual(8);
    // Allow 1% for numeric serialization boundaries in the entire return.
    // A larger input interval must not produce an increasing marginal byte slope.
    expect(slopes[1]!).toBeLessThanOrEqual(slopes[0]! * 1.01);
  });

  test(`${source.name}: measured source-field visits scale with fixed record neighborhoods`, () => {
    const options = { converterRevision: source.revision };
    let nextKey = 1000;
    const visits: number[] = [];
    for (const scale of [1, 8, 64]) {
      const inputs = Array.from({ length: scale * 8 }, () => source.seed(1, nextKey++));
      visits.push(
        sourceFieldVisits(inputs, (input) => {
          const output = source.convert(input, context, options);
          if (output.proposals.length === 0) throw new Error(`${source.name} produced no proposals`);
        }),
      );
    }
    expect(visits[0]).toBeGreaterThan(0);
    expect(visits[1]).toBe(visits[0]! * 8);
    expect(visits[2]).toBe(visits[1]! * 8);
    console.info(`${source.name} source-field visits at 1/8/64 scales: ${visits.join('/')}`);
  });
}

test('growth seeds retain VNDB native aliases and Wikidata dish classification', () => {
  const vndb = convertVndb(vndbSeed(1, 1000), context, { converterRevision: vndbRevision });
  expect(vndb.converter_revision).toBe('vndb@8');
  expect(vndb.proposals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: 'propose',
        statement: expect.objectContaining({
          property: { id: 'schema:alternateName' },
          value: { type: 'value', content: { language: 'und', text: 'Community alternate name' } },
        }),
      }),
    ]),
  );

  const wikidata = convertWikidata(wikidataSeed(1, 1000), {}, { converterRevision: wikidataRevision });
  expect(wikidata.converter_revision).toBe('wikidata-5');
  expect(wikidata.proposals[0]).toMatchObject({ op: 'create', subject: { type: 'schema:Recipe' } });
});
