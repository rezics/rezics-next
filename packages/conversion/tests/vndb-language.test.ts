import { expect, test } from 'bun:test';
import { convertVndb, converter_revision } from '../src/vndb.ts';

const subjectId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function record(olang?: string) {
  return {
    external_id: 'v9',
    record_revision: '3',
    record: {
      vn: olang === undefined ? { id: 'v9' } : { id: 'v9', olang },
      entry_meta: { id: 'v9', revision: 3 },
      vn_titles: [
        { id: 'v9', lang: 'pt-br', official: true, title: 'Título do Porto', latin: null },
        { id: 'v9', lang: 'ja', official: true, title: '港の題名', latin: 'Minato no Daimei' },
      ],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

function statements(olang?: string) {
  return convertVndb(record(olang), { subjectId }).proposals.map((proposal) => {
    if (proposal.op !== 'propose') throw new Error('expected proposals');
    return proposal.statement;
  });
}

test('VNDB writes the original language as one canonical inLanguage statement', () => {
  const languages = statements('pt-br').filter((statement) => statement.property.id === 'schema:inLanguage');
  expect(languages.map((statement) => statement.value)).toEqual([{ type: 'value', content: 'pt-BR' }]);
  expect(languages[0]!.references?.length).toBe(1);
  expect(statements().some((statement) => statement.property.id === 'schema:inLanguage')).toBe(false);
});

test('VNDB title languages and labels are canonical BCP 47 tags', () => {
  const names = statements('pt-br')
    .filter((statement) => statement.property.id === 'schema:name')
    .map((statement) => (statement.value as { content: { language: string } }).content.language)
    .sort();
  expect(names).toEqual(['ja', 'ja-Latn', 'pt-BR']);
  const bootstrap = convertVndb(record('pt-br')).proposals[0]!;
  if (bootstrap.op !== 'create') throw new Error('expected bootstrap');
  expect(Object.keys(bootstrap.subject.labels).sort()).toEqual(['ja', 'ja-Latn', 'pt-BR']);
});

test('VNDB language output change bumps the converter revision', () => {
  expect(converter_revision).not.toBe('vndb@3');
  expect(convertVndb(record('pt-br')).converter_revision).toBe(converter_revision);
});
