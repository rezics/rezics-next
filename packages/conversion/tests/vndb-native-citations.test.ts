import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { convertVndb, converter_revision } from '../src/vndb.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
function input(lastmod?: string) {
  return {
    external_id: 'v123',
    record_revision: '7',
    record: {
      vn: { id: 'v123', olang: 'en' },
      entry_meta: { id: 'v123', revision: 7, ...(lastmod === undefined ? {} : { lastmod }) },
      vn_titles: [{ id: 'v123', lang: 'en', official: true, title: 'Harbor', latin: null }],
    },
  };
}
test('all VNDB facts cite the available native version and modification day', () => {
  const request = input('2026-10-24');
  const output = convertVndb(request, { subjectId });
  expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
  expect(output.proposals.length).toBeGreaterThan(0);
  expect(output.normalizedRecord.entry_meta).toHaveProperty('lastmod', '2026-10-24');
  for (const command of output.proposals) {
    if (command.op !== 'propose') throw new Error('Expected bound proposal');
    const parts = command.statement.references?.flatMap((reference) => reference.parts) ?? [];
    expect(parts).toContainEqual({ property: { id: 'wdt:P3180' }, value: { type: 'value', content: 'v123' } });
    expect(parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://vndb.org/v123.7' },
    });
    expect(parts).toContainEqual({ property: { id: 'schema:version' }, value: { type: 'value', content: '7' } });
    expect(parts).toContainEqual({
      property: { id: 'schema:dateModified' },
      value: {
        type: 'value',
        content: {
          time: '+2026-10-24T00:00:00Z',
          precision: 11,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        },
      },
    });
  }
  expect(convertVndb({ ...request, record: output.normalizedRecord }, { subjectId })).toEqual(output);
  expect(convertVndb(request).digest).toBe(output.digest);
  expect(convertVndb(input('2026-10-25'), { subjectId }).digest).not.toBe(output.digest);
});
test('missing native modification date remains absent rather than invented', () => {
  const output = convertVndb(input(), { subjectId });
  for (const command of output.proposals) {
    if (command.op !== 'propose') throw new Error('Expected bound proposal');
    const parts = command.statement.references?.flatMap((reference) => reference.parts) ?? [];
    expect(parts.some((part) => part.property.id === 'schema:dateModified')).toBe(false);
    expect(parts).toContainEqual({ property: { id: 'schema:version' }, value: { type: 'value', content: '7' } });
    expect(command.source.record_revision).toBe('7');
  }
  expect(output.normalizedRecord.entry_meta).not.toHaveProperty('lastmod');
  expect(convertVndb(input(), { subjectId })).toEqual(output);
});
test('citation output change publishes a new converter revision', () => {
  expect(converter_revision as string).not.toBe('vndb@5');
});
