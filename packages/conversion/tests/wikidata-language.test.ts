import { expect, test } from 'bun:test';
import { convertWikidata, converter_revision } from '../src/wikidata.ts';

const subjectId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
// 78 well-formed codes outside the platform label languages, as notable Wikidata items carry.
const others = ['q', 'v', 'x'].flatMap((first) =>
  Array.from({ length: 26 }, (_, i) => first + String.fromCharCode(97 + i)),
);
const kept = ['en', 'de', 'mul', 'zh-hans'];
const ignored = [...others, 'zh-min-nan', 'be-tarask', 'simple'];

function entity() {
  const term = (language: string, value: string) => ({ language, value });
  const labels = Object.fromEntries([...kept, ...ignored].map((language) => [language, term(language, `Label ${language}`)]));
  const aliases = Object.fromEntries(ignored.map((language) => [language, [term(language, `Alias ${language}`)]]));
  return {
    external_id: 'Q571',
    record_revision: '24681012',
    record: {
      id: 'Q571',
      type: 'item',
      lastrevid: 24681012,
      labels,
      aliases,
      descriptions: { en: term('en', 'A book'), qa: term('qa', 'Other') },
      claims: {
        P31: [
          {
            id: 'Q571$00000000-0000-4000-8000-000000000001',
            type: 'statement',
            rank: 'normal',
            mainsnak: {
              snaktype: 'value',
              property: 'P31',
              datatype: 'wikibase-item',
              datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' } },
            },
          },
        ],
      },
    },
  };
}

test('Wikidata keeps platform label languages and ignores the rest without failing the record', () => {
  const bootstrap = convertWikidata(entity()).proposals[0]!;
  if (bootstrap.op !== 'create') throw new Error('expected bootstrap');
  expect(Object.keys(bootstrap.subject.labels).sort()).toEqual(['de', 'en', 'mul', 'zh-Hans']);
  expect(Object.keys(bootstrap.subject.aliases ?? {})).toEqual([]);
  expect(Object.keys(bootstrap.subject.descriptions ?? {})).toEqual(['en']);
});

test('Wikidata name statements use canonical language tags', () => {
  const languages = convertWikidata(entity(), { subjectId })
    .proposals.map((proposal) => {
      if (proposal.op !== 'propose') throw new Error('expected proposals');
      return proposal.statement;
    })
    .filter((statement) => statement.property.id === 'schema:name')
    .map((statement) => (statement.value as { content: { language: string } }).content.language)
    .sort();
  expect(languages).toEqual(['de', 'en', 'mul', 'zh-Hans']);
});

test('Wikidata language output change bumps the converter revision', () => {
  expect(converter_revision).not.toBe('wikidata-2');
  expect(convertWikidata(entity()).converter_revision).toBe(converter_revision);
});
