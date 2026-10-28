import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index.ts';
import { convertVndb, vndbLimits } from '../src/vndb.ts';

const context = { subjectId: '00000000-0000-4000-8000-000000000001' };
function input(lastmod: unknown) {
  return {
    external_id: 'v123',
    record_revision: '7',
    record: {
      vn: { id: 'v123', olang: 'en' },
      entry_meta: { id: 'v123', revision: 7, lastmod },
      vn_titles: [{ id: 'v123', lang: 'en', official: true, title: 'Harbor', latin: null }],
    },
  };
}

test('native timestamps retain their exact metadata and cite their supplied calendar day', () => {
  for (const lastmod of [
    '2024-02-29',
    '2024-02-29 23:59:59',
    '2024-02-29T23:59:59.123456Z',
    '2024-02-29 00:01:00+02',
    '2024-02-29T23:59:59-0530',
    '2024-02-29T23:59:59.1-05:30',
  ]) {
    const request = input(lastmod);
    const output = convertVndb(request, context);
    expect(output.normalizedRecord.entry_meta.lastmod).toBe(lastmod);
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
    for (const command of output.proposals) {
      if (command.op !== 'propose') throw new Error('Expected bound proposal');
      expect(command.statement.references.flatMap((reference) => reference.parts)).toContainEqual({
        property: { id: 'schema:dateModified' },
        value: {
          type: 'value',
          content: {
            time: '+2024-02-29T00:00:00Z',
            precision: 11,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      });
    }
    expect(convertVndb({ ...request, record: output.normalizedRecord }, context)).toEqual(output);
  }
  expect(convertVndb(input('2024-02-29T12:00:00Z')).digest).not.toBe(convertVndb(input('2024-02-29T13:00:00Z')).digest);
});

test('malformed supplied native timestamps fail safely instead of becoming missing dates', () => {
  for (const lastmod of [
    null,
    20261024,
    '',
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-10-24T24:00:00Z',
    '2026-10-24 23:60:00',
    '2026-10-24T23:59:60Z',
    '2026-10-24T12:00:00.1234567Z',
    ' 2026-10-24',
    '2026-10-24\n',
    '2026-10-24PRIVATE_SENTINEL',
  ]) {
    try {
      convertVndb(input(lastmod), context);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionError);
      expect((error as ConversionError).pointer).toBe('/entry_meta/lastmod');
      expect(String(error)).not.toContain('PRIVATE_SENTINEL');
    }
  }
});

test('native creation time cannot substitute for a missing modification date', () => {
  const request = input(undefined);
  const output = convertVndb(
    {
      ...request,
      record: {
        ...request.record,
        entry_meta: { ...request.record.entry_meta, created: '2020-01-01' },
      },
    },
    context,
  );
  expect(output.normalizedRecord.entry_meta).toEqual({ id: 'v123', revision: 7 });
  for (const command of output.proposals) {
    if (command.op !== 'propose') throw new Error('Expected bound proposal');
    expect(
      command.statement.references
        .flatMap((reference) => reference.parts)
        .some((part) => part.property.id === 'schema:dateModified'),
    ).toBe(false);
  }
});

test('combined VNDB title and link limits preserve all 98 cited facts', () => {
  const request = input('2026-10-24');
  const record = {
    ...request.record,
    vn_titles: Array.from({ length: 64 }, (_, i) => ({
      id: 'v123',
      lang: `en-x-t${i}`,
      official: true,
      title: `T${i}`,
      latin: null,
    })),
    vn_extlinks: Array.from({ length: 32 }, (_, i) => ({ id: 'v123', link: i + 1 })),
    extlinks: Array.from({ length: 32 }, (_, i) => ({
      id: i + 1,
      site: 'website',
      value: `https://example.org/${i}`,
    })),
  };
  const output = convertVndb({ ...request, record }, context);
  expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
  expect(vndbLimits.maxCommands).toBe(98);
  expect(output.proposals).toHaveLength(98);
  for (const [property, count] of [
    ['wdt:P3180', 1],
    ['schema:name', 64],
    ['schema:url', 32],
    ['schema:inLanguage', 1],
  ] as const) {
    expect(
      output.proposals.filter((command) => command.op === 'propose' && command.statement.property.id === property),
    ).toHaveLength(count);
  }
  expect(
    output.proposals.every(
      (command) => command.op === 'propose' && command.statement.references[0]?.parts.length === 4,
    ),
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(output.normalizedRecord))).toBeLessThan(vndbLimits.recordBytes);
});
