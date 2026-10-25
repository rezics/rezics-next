import { expect, test } from 'bun:test';
import { convertOpenLibrary, converter_revision } from '../src/open-library.ts';

const subjectId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function edition(languages: string[]) {
  return {
    external_id: '/books/OL900000002M',
    record_revision: '11',
    record: {
      type: { key: '/type/edition' },
      key: '/books/OL900000002M',
      revision: 11,
      last_modified: { type: '/type/datetime', value: '2025-02-03T04:05:06.654321' },
      title: 'The Glass Atlas: Pocket Edition',
      languages: languages.map((code) => ({ key: `/languages/${code}` })),
    },
  };
}

function languages(codes: string[]) {
  return convertOpenLibrary(edition(codes), { subjectId })
    .proposals.map((proposal) => {
      if (proposal.op !== 'propose') throw new Error('expected proposals');
      return proposal.statement;
    })
    .filter((statement) => statement.property.id === 'schema:inLanguage');
}

test('Open Library edition languages become one canonical inLanguage statement per language', () => {
  const statements = languages(['fre', 'eng', 'eng']);
  expect(
    statements.map((statement) => statement.value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ).toEqual([
    { type: 'value', content: 'en' },
    { type: 'value', content: 'fr' },
  ]);
  for (const statement of statements) expect(statement.references?.length).toBe(1);
});

test('Open Library undetermined or absent languages write no inLanguage value', () => {
  expect(languages(['und'])).toEqual([]);
  expect(languages([])).toEqual([]);
});

test('Open Library language output change bumps the converter revision', () => {
  expect(converter_revision).not.toBe('open-library@1');
  expect(convertOpenLibrary(edition(['eng'])).converter_revision).toBe(converter_revision);
});
