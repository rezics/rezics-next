import { expect, mock, test } from 'bun:test';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { conceptTypeAdmitted, readSourceConcept } from '../src/features/catalogue/source-concept-explorer';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';

mock.module('cloudflare:workers', () => ({ env: {} }));

const concept = '00000000-0000-4000-8000-00000000c001';
const schemeA = '00000000-0000-4000-8000-00000000c002';
const schemeB = '00000000-0000-4000-8000-00000000c003';
const broader = '00000000-0000-4000-8000-00000000c004';

function item(mode: 'ok' | 'unreadable' | 'retired'): SubjectRead {
  return {
    subject: {
      id: concept,
      type: 'skos:Concept',
      revision: 1,
      release:
        mode === 'retired'
          ? 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          : 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: 'Protagonist', ja: '主人公' },
      descriptions: { en: 'Lead role' },
      aliases: { en: ['Hero', 'Protagonist'], ja: ['主人公'] },
      statements: {
        'skos:inScheme': [
          {
            id: '00000000-0000-4000-8000-00000000e021',
            rank: 'normal',
            property: { id: 'skos:inScheme', data_type: 'wikibase-item' },
            value: { type: 'value', content: schemeA },
            qualifiers: [],
            references: [],
          },
          {
            id: '00000000-0000-4000-8000-00000000e022',
            rank: 'normal',
            property: { id: 'skos:inScheme', data_type: 'wikibase-item' },
            value: { type: 'value', content: schemeB },
            qualifiers: [],
            references: [],
          },
        ],
        'skos:broader': [
          {
            id: '00000000-0000-4000-8000-00000000e023',
            rank: 'normal',
            property: { id: 'skos:broader', data_type: 'wikibase-item' },
            value: { type: 'value', content: broader },
            qualifiers: [],
            references: [],
          },
        ],
        'schema:sameAs': [
          {
            id: '00000000-0000-4000-8000-00000000e024',
            rank: 'normal',
            property: { id: 'schema:sameAs', data_type: 'url' },
            value: { type: 'value', content: 'https://vndb.org/i1' },
            qualifiers: [],
            references: [],
          },
        ],
      },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {
      [schemeA]: { type: 'skos:ConceptScheme', labels: { en: 'VNDB traits' } },
      [schemeB]: { type: 'skos:ConceptScheme', labels: { en: 'Bangumi tags' } },
      [broader]: { type: 'skos:Concept', labels: { en: 'Role' } },
    },
    summary: null,
  };
}

function client(mode: 'ok' | 'unreadable' | 'retired') {
  return {
    subjects: ({ id }: { id: string }) => ({
      get: async () => (mode === 'unreadable' ? { status: 404 } : { status: 200, data: item(mode) }),
      links: {
        get: async ({ query }: { query: { cursor?: string } }) => ({
          status: 200,
          data: {
            links: [
              {
                subject: '00000000-0000-4000-8000-00000000c005',
                statement: '00000000-0000-4000-8000-00000000e025',
                summary: {
                  id: '00000000-0000-4000-8000-00000000c005',
                  type: 'skos:Concept',
                  label: { value: 'Heroine', language: 'en' },
                },
                related: {},
              },
            ],
            next: query.cursor ? null : 'concept-next',
            freshness: { caught_up: true },
          },
        }),
      },
    }),
  } as unknown as KernelClient;
}

test('source concept explorer covers two schemes, duplicate labels, unknown roles, continuation and retired meaning', async () => {
  expect(conceptTypeAdmitted(bundledRelease, 'skos:Concept')).toBe(true);
  const read = await readSourceConcept(client('ok'), 'Bearer reader', bundledRelease, concept, 'en', {
    role: 'vndb:unknown',
  });
  if (!read.ok) throw new Error('expected concept');
  expect(read.schemes.map((scheme) => scheme.label).sort()).toEqual(['Bangumi tags', 'VNDB traits']);
  expect(read.aliases.filter((alias) => alias.text === 'Protagonist').length).toBe(1);
  expect(read.codes.some((code) => code.unknown && code.value === 'vndb:unknown')).toBe(true);
  expect(read.hierarchy.some((row) => row.direction === 'broader' && row.id === broader)).toBe(true);
  expect(read.next).toBe('concept-next');
  const continued = await readSourceConcept(client('ok'), 'Bearer reader', bundledRelease, concept, 'en', {
    cursor: 'concept-next',
  });
  expect(continued.ok && continued.next).toBeNull();
  const retired = await readSourceConcept(
    client('retired'),
    'Bearer reader',
    { ...bundledRelease, digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    concept,
    'en',
    {
      pin: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  );
  expect(retired.ok && retired.retired).toBe(true);
  expect(await readSourceConcept(client('unreadable'), 'Bearer reader', bundledRelease, concept, 'en', {})).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  const unknown = await readSourceConcept(client('ok'), 'Bearer reader', bundledRelease, concept, 'en', {});
  expect(unknown.ok && conceptTypeAdmitted(bundledRelease, 'schema:Book')).toBe(false);
  expect(catalogueEntries.concepts({ id: concept, label: 'Protagonist', locale: 'en' }).href).toContain('/concepts');
});
