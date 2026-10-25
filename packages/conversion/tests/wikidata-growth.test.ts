import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index';
import { convertWikidata, converter_revision, wikidataLimits } from '../src/wikidata';

const subjectId = '00000000-0000-4000-8000-000000000001';

// One generator varies only supported Wikidata data and can produce independent IDs.
function seed(aliasTextSize: number, fields = 8, id = 'Q571') {
  return {
    id,
    type: 'item',
    lastrevid: 7,
    labels: { en: { language: 'en', value: 'Growth book' } },
    aliases: {
      en: Array.from({ length: 60 }, (_, i) => ({ language: 'en', value: `${i}-${'é'.repeat(aliasTextSize)}` })),
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
              value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
            },
          },
        },
      ],
      P856: Array.from({ length: fields - 1 }, (_, i) => ({
        type: 'statement',
        rank: 'normal',
        mainsnak: {
          property: 'P856',
          snaktype: 'value',
          datatype: 'url',
          datavalue: { type: 'string', value: `https://example.org/book/${i}` },
        },
      })),
    },
  };
}
const input = (record: ReturnType<typeof seed>) => ({
  external_id: record.id,
  record_revision: '7',
  record,
});
const serialize = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

test('pure converter growth stays within its declared field and byte cap', () => {
  expect(wikidataLimits.statements).toBe(64);
  let previousBytes = 0;
  for (const [aliasTextSize, expectedInputRange] of [
    [350, [40_000, 60_000]],
    [750, [85_000, 105_000]],
    [1050, [120_000, wikidataLimits.bytes]],
  ] as const) {
    const record = seed(aliasTextSize);
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    const output = convertWikidata(input(record), { subjectId });
    expect(bytes).toBeGreaterThanOrEqual(expectedInputRange[0]);
    expect(bytes).toBeLessThanOrEqual(expectedInputRange[1]);
    expect(bytes).toBeGreaterThan(previousBytes);
    expect(Object.hasOwn(output, 'metrics')).toBe(false);
    expect(output.proposals).toHaveLength(8);
    expect(output.proposals.length).toBeLessThanOrEqual(100);
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
    expect(output.assets).toEqual([]);
    expect(convertWikidata(input(output.normalizedRecord as ReturnType<typeof seed>), { subjectId })).toEqual(output);
    expect(convertWikidata(input(record), { subjectId })).toEqual(output);
    previousBytes = bytes;
  }
  expect(() => convertWikidata(input(seed(1, 65)), { subjectId })).toThrow(ConversionError);
  const huge = seed(1);
  huge.labels.en.value = 'x'.repeat(wikidataLimits.bytes + 1);
  expect(() => convertWikidata(input(huge), { subjectId })).toThrow(ConversionError);
});

test('whole-return logical bytes grow linearly with supported native input bytes', () => {
  const samples = [350, 750, 1050].map((aliasTextSize) => {
    const conversionInput = input(seed(aliasTextSize));
    const output = convertWikidata(conversionInput, { subjectId });
    expect(output.proposals).toHaveLength(8);
    return {
      inputBytes: Buffer.byteLength(JSON.stringify(conversionInput.record), 'utf8'),
      // Count all returned JSON: normalized hash input, diagnostics, metadata, proposals and assets.
      returnBytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
    };
  });
  expect(samples).toHaveLength(3);
  const slopes: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    expect(sample.inputBytes).toBeLessThanOrEqual(wikidataLimits.bytes);
    expect(sample.returnBytes).toBeGreaterThan(0);
    if (i === 0) continue;
    const previous = samples[i - 1]!;
    expect(sample.inputBytes).toBeGreaterThan(previous.inputBytes);
    expect(sample.returnBytes).toBeGreaterThan(previous.returnBytes);
    slopes.push((sample.returnBytes - previous.returnBytes) / (sample.inputBytes - previous.inputBytes));
  }
  expect(samples[2]!.inputBytes).toBeGreaterThan(wikidataLimits.bytes * 0.9);
  expect(slopes[0]!).toBeLessThanOrEqual(8);
  expect(slopes[1]!).toBeLessThanOrEqual(slopes[0]! * 1.01);
});

test('fixed conversion return is byte-identical after unrelated actual conversions', () => {
  const record = seed(8);
  const anchor = input(record);
  const expected = serialize(convertWikidata(anchor, { subjectId }));
  const deny = () => {
    throw new Error('Unexpected conversion I/O');
  };
  const bunIO = Bun as unknown as {
    SQL: (...args: unknown[]) => unknown;
    connect: (...args: unknown[]) => unknown;
    file: (...args: unknown[]) => unknown;
    write: (...args: unknown[]) => unknown;
  };
  const guards = [
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(deny, { preconnect: deny })),
    spyOn(bunIO, 'SQL').mockImplementation(deny),
    spyOn(bunIO, 'connect').mockImplementation(deny),
    spyOn(bunIO, 'file').mockImplementation(deny),
    spyOn(bunIO, 'write').mockImplementation(deny),
    spyOn(fs, 'readFileSync').mockImplementation(deny),
    spyOn(fs, 'writeFileSync').mockImplementation(deny),
    spyOn(net, 'connect').mockImplementation(deny),
  ];
  try {
    let nextId = 1;
    for (const count of [1, 8, 64]) {
      for (let i = 0; i < count; i++) {
        const unrelated = input(seed(1, 1, `Q${nextId++}`));
        expect(unrelated.external_id).not.toBe(anchor.external_id);
        const result = convertWikidata(unrelated, { subjectId });
        expect(result.proposals.length).toBeGreaterThan(0);
      }
      expect(serialize(convertWikidata(anchor, { subjectId }))).toEqual(expected);
    }
    for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  } finally {
    guards.forEach((guard) => guard.mockRestore());
  }
});

test('source scalars remain sensitive while target registration and private data stay outside the digest', () => {
  const record = seed(8);
  const original = convertWikidata(input(record), { subjectId });
  record.labels.en.value = 'Changed title';
  const changed = convertWikidata(input(record), { subjectId });
  expect(changed.digest).not.toBe(original.digest);
  expect(JSON.stringify(changed.proposals)).toContain('Changed title');
  const pollution = { ...record, account: { password: 'PRIVATE' }, posts: ['PRIVATE'], converter_revision: 'forged' };
  expect(convertWikidata(input(pollution), { subjectId })).toEqual(changed);
  const rebound = convertWikidata(
    input(record),
    {
      subjectId: '00000000-0000-4000-8000-000000000002',
      mediaIds: { ignored: subjectId },
    },
    { converterRevision: 'registered-next' },
  );
  expect(rebound.digest).toBe(changed.digest);
  expect(rebound.converter_revision).toBe('registered-next');
  expect(original.converter_revision).toBe(converter_revision);
  expect(JSON.stringify(changed.normalizedRecord)).not.toContain('PRIVATE');
});
