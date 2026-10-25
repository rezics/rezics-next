import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index';
import { convertWikidata, converter_revision, wikidataLimits } from '../src/wikidata';

const subjectId = '00000000-0000-4000-8000-000000000001';

// One generator varies only the explicit source statement population.
function seed(fields: number) {
  return {
    id: 'Q571',
    type: 'item',
    lastrevid: 7,
    labels: { en: { language: 'en', value: 'Growth book' } },
    aliases: {},
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
const input = (record: unknown) => ({ external_id: 'Q571', record_revision: '7', record });

test('pure converter growth stays within its declared field and byte cap', () => {
  expect(wikidataLimits.statements).toBe(64);
  let previousBytes = 0;
  let previousVisits = 0;
  for (const fields of [1, 8, 64]) {
    const record = seed(fields);
    const bytes = Buffer.byteLength(JSON.stringify(record));
    const output = convertWikidata(input(record), { subjectId });
    expect(output.metrics.inputBytes).toBe(bytes);
    expect(output.metrics.inputBytes).toBeGreaterThan(previousBytes);
    expect(output.metrics.fieldVisits).toBeGreaterThan(previousVisits);
    expect(output.metrics.fieldVisits).toBeLessThanOrEqual(100 * fields + 100);
    expect(output.proposals).toHaveLength(fields);
    expect(output.proposals.length).toBeLessThanOrEqual(100);
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
    expect(output.assets).toEqual([]);
    expect(convertWikidata(input(output.normalizedRecord), { subjectId })).toEqual(output);
    expect(convertWikidata(input(record), { subjectId })).toEqual(output);
    previousBytes = output.metrics.inputBytes;
    previousVisits = output.metrics.fieldVisits;
  }
  expect(() => convertWikidata(input(seed(65)), { subjectId })).toThrow(ConversionError);
  const huge = seed(1);
  huge.labels.en.value = 'x'.repeat(wikidataLimits.bytes + 1);
  expect(() => convertWikidata(input(huge), { subjectId })).toThrow(ConversionError);
});

test('fixed conversion touches zero SQL network or filesystem across unrelated populations', () => {
  const record = seed(8);
  const expected = convertWikidata(input(record), { subjectId });
  const deny = () => {
    throw new Error('Unexpected conversion I/O');
  };
  const guards = [
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(deny, { preconnect: deny })),
    spyOn(Bun, 'SQL').mockImplementation(deny),
    spyOn(Bun, 'connect').mockImplementation(deny),
    spyOn(Bun, 'file').mockImplementation(deny),
    spyOn(Bun, 'write').mockImplementation(deny),
    spyOn(fs, 'readFileSync').mockImplementation(deny),
    spyOn(fs, 'writeFileSync').mockImplementation(deny),
    spyOn(net, 'connect').mockImplementation(deny),
    spyOn(Date, 'now').mockImplementation(deny),
    spyOn(Math, 'random').mockImplementation(deny),
  ];
  try {
    for (const n of [1, 8, 64]) {
      const unrelated = Array.from({ length: n }, () => Array.from({ length: n }, () => seed(1)));
      expect(unrelated).toHaveLength(n);
      expect(convertWikidata(input(record), { subjectId })).toEqual(expected);
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
