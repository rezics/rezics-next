import { fromPlainText } from '@rezics/document';
import type { PropertyDefinition } from '@rezics/definitions';
import { peopleProfileFixture } from '../../../kernel/fake/catalogue-people-profile';
import type { PersonStatement } from './model';

/** Illustrative admitted responses, not a native configuration or publication. */
export function personReaderExample(state: 'admitted' | 'empty' | 'withheld' | 'unsupported' = 'admitted') {
  const fixture = peopleProfileFixture('ready', 'en', 'person');
  const { release, person: read } = fixture;
  const occupation = '00000000-0000-4000-8000-00000000d201';
  const language = '00000000-0000-4000-8000-00000000d202';
  const document = '00000000-0000-4000-8000-00000000d203';
  const biography = '00000000-0000-4000-8000-00000000d204';
  const digest = 'a'.repeat(64);
  const item = (label: string): PropertyDefinition => ({
    iri: 'http://schema.org/knowsLanguage',
    value: { type: 'string' },
    labels: { en: label, ja: label === 'Occupation' ? '職業' : '使用言語' },
    descriptions: {},
    datatype: 'wikibase-item',
    targets: ['skos:Concept'],
    mappings: [],
    qualifiers: ['schema:startDate'],
    multivalued: true,
    relation: { group: 'classification', order: 'name', inverse: 'none' },
  });
  const statement = (
    property: string,
    content: unknown,
    datatype: PersonStatement['property']['data_type'],
  ): PersonStatement => ({
    id: crypto.randomUUID(),
    property: { id: property, data_type: datatype },
    value: { type: 'value', content },
    rank: 'normal',
    qualifiers: [],
    references: [
      {
        hash: 'source',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://example.org/biography' },
          },
        ],
      },
    ],
    rezics: { release: 'sha256:example', revision: 1 },
  });
  const documents: Record<string, unknown> = {};
  if (state !== 'unsupported') {
    release.properties['wdt:P106'] = item('Occupation');
    release.properties['schema:knowsLanguage'] = item('Working language');
    release.types['schema:Person']!.properties.push('schema:abstract', 'wdt:P106', 'schema:knowsLanguage');
    if (state !== 'empty') {
      const bio = statement('schema:abstract', { document, language: 'en', digest }, 'document');
      bio.id = biography;
      read.subject.statements['schema:abstract'] = [bio];
      const work = statement('wdt:P106', occupation, 'wikibase-item');
      work.qualifiers.push({
        property: { id: 'schema:startDate', data_type: 'time' },
        value: { type: 'value', content: { time: '+2020-00-00T00:00:00Z', precision: 9 } },
      });
      read.subject.statements['wdt:P106'] = [work];
      read.subject.statements['schema:knowsLanguage'] = [statement('schema:knowsLanguage', language, 'wikibase-item')];
      read.related[occupation] = { type: 'skos:Concept', labels: { en: 'Director', ja: '監督' } };
      read.related[language] = { type: 'skos:Concept', labels: { en: 'Japanese', ja: '日本語' } };
      documents[biography] = {
        id: document,
        subjectId: read.subject.id,
        candidateId: biography,
        digest,
        language: 'en',
        availability: 'available',
        body: fromPlainText('Mira directs independent films.'),
      };
      if (state === 'withheld') {
        delete read.related[occupation];
        delete documents[biography];
      }
    }
  }
  return { release, read, documents, occupation, language, biography, statement };
}
