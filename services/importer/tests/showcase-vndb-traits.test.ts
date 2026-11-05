import { expect, test } from 'bun:test';
import { mapVndbVocabulary } from '@rezics/conversion/vndb-vocabulary';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { developmentShowcaseSelection } from '../../../scripts/datasets/cross-media-seed.ts';
import {
  emptyCrossMediaPlan,
  planCrossMediaSeed,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { prepareShowcaseVndbTraits } from '../src/showcase-vndb-traits.ts';
import {
  planShowcaseCharacterVocabulary,
  profileFromCharacterVocabularyBindings,
} from '../src/showcase-character-vocabulary.ts';

const scheme = '00000000-0000-4000-8000-000000000010';
const concepts = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
const subjects = Object.fromEntries([
  ['vndb-character-traits-scheme', scheme],
  ...['i23', 'i30'].map((code, index) => [`vndb-character-traits-${code}`, concepts[index]!]),
]);

function vocabularyPort(unavailable?: 'withdrawn' | 'wrong-scheme') {
  return {
    readReviewedSubject: async (id: string) => ({
      subject: {
        id,
        type: id === scheme ? 'skos:ConceptScheme' : 'skos:Concept',
        statements:
          id === concepts[1] && unavailable === 'withdrawn'
            ? {}
            : {
                'schema:url': [
                  {
                    value: {
                      content: `https://rezics.com/schemes/vndb/character-traits${id === scheme ? '' : `/${['i23', 'i30'][concepts.indexOf(id)]}`}`,
                    },
                  },
                ],
                ...(id === scheme
                  ? {}
                  : {
                      'skos:inScheme': [
                        {
                          value: {
                            content: id === concepts[1] && unavailable === 'wrong-scheme' ? concepts[0] : scheme,
                          },
                        },
                      ],
                    }),
              },
      },
    }),
  } as unknown as CrossMediaPort;
}

test('the development trait adapter reuses current reviewed Concepts only for its elected characters', async () => {
  const plan = emptyCrossMediaPlan();
  plan.entities.vndb.push({ source: 'vndb', key: 'c6487', revision: null, payload: { id: 'c6487' } });
  const port = vocabularyPort();
  const sourcePlan = {
    ...emptyCrossMediaPlan(),
    traits: [
      { id: 'c6487', tid: 'i23', spoil: '0', lie: 'f' },
      { id: 'c6487', tid: 'i99', spoil: '0', lie: 'f' },
      { id: 'c9999', tid: 'i23', spoil: '0', lie: 'f' },
    ],
    appearances: [],
  };
  const prepared = await prepareShowcaseVndbTraits(plan, sourcePlan, port, subjects);
  const request = prepared.vocabularyAdmission.request!({
    owner: { source: 'vndb_cross_media', external_id: 'c6487' },
    subject: '00000000-0000-4000-8000-000000000020',
  } as never);
  expect(request?.rows).toHaveLength(1);
  expect(request?.rows[0]).toMatchObject({ kind: 'character-trait', code: 'i23', spoiler: 0, lie: false });
  expect(prepared.bindings.concepts.map((concept) => concept.code)).toEqual(['i23']);
  expect(profileFromCharacterVocabularyBindings(prepared.bindings)?.traits).toEqual({
    schemeId: scheme,
    concepts: [{ code: 'i23', id: concepts[0]! }],
  });
  plan.records.vndb.push(plan.entities.vndb.pop()!);
  const fromRecords = await prepareShowcaseVndbTraits(plan, sourcePlan, port, subjects);
  expect(fromRecords.traits).toEqual(prepared.traits);
  const withdrawn = await prepareShowcaseVndbTraits(
    plan,
    sourcePlan,
    { ...port, readReviewedSubject: async () => ({ subject: {} }) } as never,
    subjects,
  );
  expect(withdrawn.bindings.concepts).toEqual([]);
  expect(withdrawn.traits).toEqual(prepared.traits);
});

test('withdrawn or wrong-Scheme reviewed traits withhold only their own association', async () => {
  const plan = emptyCrossMediaPlan();
  plan.records.vndb.push({ source: 'vndb', key: 'c6487', revision: null, payload: { id: 'c6487' } });
  const sourcePlan = {
    ...plan,
    traits: ['i23', 'i30', 'i99'].map((tid) => ({ id: 'c6487', tid, spoil: '1', lie: 'f' })),
    appearances: [],
  };
  for (const unavailable of ['withdrawn', 'wrong-scheme'] as const) {
    const prepared = await prepareShowcaseVndbTraits(plan, sourcePlan, vocabularyPort(unavailable), subjects);
    expect(prepared.bindings.concepts.map((concept) => concept.code)).toEqual(['i23']);
    const request = prepared.vocabularyAdmission.request!({
      owner: { source: 'vndb_cross_media', external_id: 'c6487' },
      subject: '00000000-0000-4000-8000-000000000020',
    } as never)!;
    expect(request.rows.map((row) => ('code' in row ? row.code : undefined))).toEqual(['i23', 'i30']);
    const mapped = mapVndbVocabulary({
      ...request,
      metadata: {
        provider: 'vndb',
        sourceAlias: 'vndb_cross_media',
        externalId: 'c6487',
        recordRevision: null,
        digest: 'a'.repeat(64),
        converterRevision: converter_revision,
        recordUrl: 'https://vndb.org/c6487',
        license: 'CC0-1.0',
        attribution: 'VNDB',
      },
    });
    expect(mapped.proposals).toHaveLength(1);
    expect(mapped.gaps).toMatchObject([{ code: 'i30', reason: 'missing_concept' }]);
  }
});

test('the development selector keeps its five exact works and only their direct cast and episodes', async () => {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 10380, type: 2, name: 'STEINS;GATE' },
      { id: 84148, type: 1, name: 'STEINS;GATE Official Book' },
      { id: 51, type: 2, name: 'CLANNAD' },
      { id: 88, type: 2, name: 'STEINS;GATE unrelated work' },
    ],
    'bangumi/subject-relations': [{ subject_id: 10380, related_subject_id: 88, relation_type: 1 }],
    'bangumi/subject-persons': Array.from({ length: 80 }, (_, index) => ({
      subject_id: index < 40 ? 10380 : 51,
      person_id: index + 100,
      position: 1,
    })),
    'bangumi/person': Array.from({ length: 80 }, (_, index) => ({ id: index + 100, type: 1, name: `Person ${index}` })),
    'bangumi/subject-characters': [{ subject_id: 10380, character_id: 700 }],
    'bangumi/character': [{ id: 700, name: 'Direct character' }],
    'bangumi/episode': [
      { id: 701, subject_id: 10380, name: 'Direct episode', sort: 1 },
      { id: 702, subject_id: 88, name: 'Unselected episode', sort: 1 },
    ],
    'vndb/vn_titles': [
      { id: 'v2002', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v4', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v8', lang: 'ja', official: 't', title: 'CLANNAD side story', latin: null },
    ],
    'vndb/vn': [
      { id: 'v2002', olang: 'ja', alias: null },
      { id: 'v4', olang: 'ja', alias: null },
      { id: 'v8', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': [
      { id: 'v2002', revision: '1', lastmod: '2026-11-01 00:00:00+00' },
      { id: 'v4', revision: '1', lastmod: '2026-11-01 00:00:00+00' },
      { id: 'v8', revision: '1', lastmod: '2026-11-01 00:00:00+00' },
    ],
    'vndb/vn_relations': [{ id: 'v2002', vid: 'v8', relation: 'seq' }],
    'vndb/chars': [{ id: 'c6487', name: 'Selected heroine', main: null }],
    'vndb/chars_traits': [
      { id: 'c6487', tid: 'i23', spoil: '1', lie: 'f' },
      { id: 'c6487', tid: 'i99', spoil: '0', lie: 'f' },
    ],
    'vndb/chars_vns': [{ id: 'c6487', vid: 'v2002', rid: null, role: 'main', spoil: '2' }],
    'vndb/traits': [
      { id: 'i23', name: 'Reviewed trait' },
      { id: 'i99', name: 'Unreviewed trait' },
    ],
    'vndb/releases_vn': [{ id: 'r9', vid: 'v2002', rtype: 'complete' }],
    'vndb/vn_staff': Array.from({ length: 65 }, (_, index) => ({
      id: 'v2002',
      aid: String(index + 1),
      role: 'scenario',
    })),
    'vndb/staff_alias': Array.from({ length: 65 }, (_, index) => ({
      id: `s${index + 1}`,
      aid: String(index + 1),
      name: `Staff ${index + 1}`,
    })),
    'vndb/staff': Array.from({ length: 65 }, (_, index) => ({
      id: `s${index + 1}`,
      main: String(index + 1),
      name: `Staff ${index + 1}`,
    })),
  };
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
  const plan = await planCrossMediaSeed(tables, { selection: developmentShowcaseSelection });
  expect(plan.records.bangumi.map((row) => row.key).sort()).toEqual(['10380', '51', '84148']);
  expect(plan.records.vndb.map((row) => row.key).sort()).toEqual(['v2002', 'v4']);
  expect(plan.entities.bangumi.map((row) => row.key)).toContain('character:700');
  expect(plan.entities.bangumi.map((row) => row.key)).toContain('episode:701');
  expect(plan.entities.bangumi.map((row) => row.key)).not.toContain('episode:702');
  expect(plan.entities.vndb.some((row) => row.key === 'r9')).toBe(false);
  expect(plan.entities.bangumi.filter((row) => row.key.startsWith('person:'))).toHaveLength(64);
  expect(plan.entities.vndb.filter((row) => /^s[1-9][0-9]*$/u.test(row.key))).toHaveLength(64);
  expect(plan.edges.some((edge) => edge.target === '88' || edge.holder === 'v8')).toBe(false);
  const vocabulary = await planShowcaseCharacterVocabulary(tables, plan);
  const prepared = await prepareShowcaseVndbTraits(plan, vocabulary.plan, vocabularyPort(), subjects);
  expect(prepared.traits).toEqual([{ id: 'c6487', tid: 'i23', spoil: '1', lie: 'f' }]);
  expect(prepared.bindings.concepts.map((concept) => concept.id)).toEqual([concepts[0]!]);
  expect(vocabulary.requirements.terms.map((term) => term.code).sort()).toEqual(['i23', 'i99', 'main']);
});
