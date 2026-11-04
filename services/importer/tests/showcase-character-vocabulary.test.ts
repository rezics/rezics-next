import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import { CrossMediaDumpFiles, planCrossMediaSeed, type CrossMediaPort, type CrossMediaTables } from '../src/cross-media-seed.ts';
import {
  composeVndbCharacterVocabularyBindings,
  parseVndbCharacterVocabularyProfile,
  planShowcaseCharacterVocabulary,
} from '../src/showcase-character-vocabulary.ts';
import {
  appearanceRoleConceptUri,
  appearanceRoleSchemeUri,
  characterTraitConceptUri,
  characterTraitSchemeUri,
} from '../src/vndb-character-traits.ts';

const traitSchemeId = '00000000-0000-4000-8000-000000000090';
const traitIds = new Map([
  ['i73', '00000000-0000-4000-8000-000000000091'],
  ['i10', '00000000-0000-4000-8000-000000000094'],
  ['i7', '00000000-0000-4000-8000-000000000095'],
  ['i99', '00000000-0000-4000-8000-000000000096'],
]);
const roleSchemeId = '00000000-0000-4000-8000-000000000092';
const mainRoleId = '00000000-0000-4000-8000-000000000093';

test('default selected-family planning closes only evidenced VNDB character vocabulary and current bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-character-vocabulary-'));
  try {
    const vndb = join(directory, 'vndb');
    await mkdir(join(vndb, 'db'), { recursive: true });
    const copy = async (table: string, header: string, rows: string) => {
      await writeFile(join(vndb, 'db', `${table}.header`), `${header}\n`);
      await writeFile(join(vndb, 'db', table), rows);
    };
    await copy('chars_traits', 'id\ttid\tspoil\tlie', 'c1\ti73\t1\tf\nc2\ti80\t0\tt\nc9\ti99\t0\tf\n');
    await copy('chars_vns', 'id\tvid\trid\trole\tspoil', 'c1\tv1\t\\N\tmain\t0\nc2\tv1\t\\N\tsupport\t1\nc9\tv4\t\\N\tmain\t0\n');
    await copy(
      'traits',
      'id\tgid\tgorder\tdefaultspoil\tsexual\tsearchable\tapplicable\tname\talias\tdescription',
      'i73\ti10\t0\t0\tf\tt\tt\tSilver hair\t\\N\t\\N\ni10\ti7\t1\t0\tf\tt\tt\tHair\t\\N\t\\N\ni7\t\\N\t2\t0\tf\tt\tt\tAppearance\t\\N\t\\N\ni99\t\\N\t3\t0\tf\tt\tt\tUnrelated trait\t\\N\t\\N\n',
    );
    await copy('traits_parents', 'id\tparent\tmain', 'i73\ti10\tt\ni10\ti7\tt\n');
    const raw = new CrossMediaDumpFiles('', vndb);
    const sourceRows: Record<string, Record<string, unknown>[]> = {
      'bangumi/subject': [
        { id: 1, type: 2, name: 'STEINS;GATE', name_cn: 'STEINS;GATE' },
        { id: 2, type: 2, name: 'CLANNAD', name_cn: 'CLANNAD' },
        { id: 3, type: 2, name: 'Fate/stay night', name_cn: 'Fate/stay night' },
      ],
      'vndb/vn_titles': [
        { id: 'v1', lang: 'en', official: 't', title: 'STEINS;GATE', latin: null },
        { id: 'v2', lang: 'en', official: 't', title: 'CLANNAD', latin: null },
        { id: 'v3', lang: 'en', official: 't', title: 'Fate/stay night', latin: null },
        { id: 'v4', lang: 'en', official: 't', title: 'An unrelated visual novel', latin: null },
      ],
      'vndb/vn': [
        { id: 'v1', olang: 'ja', alias: null },
        { id: 'v2', olang: 'ja', alias: null },
        { id: 'v3', olang: 'ja', alias: null },
        { id: 'v4', olang: 'en', alias: null },
      ],
      'vndb/entry_meta': [
        { id: 'v1', revision: '1', lastmod: '2026-11-01' },
        { id: 'v2', revision: '1', lastmod: '2026-11-01' },
        { id: 'v3', revision: '1', lastmod: '2026-11-01' },
        { id: 'v4', revision: '1', lastmod: '2026-11-01' },
      ],
      'vndb/chars': [
        { id: 'c1', name: 'Selected character', main: null },
        { id: 'c2', name: 'Selected supporting character', main: null },
        { id: 'c9', name: 'Unrelated character', main: null },
      ],
    };
    const copyTables = new Set(['chars_traits', 'chars_vns', 'traits', 'traits_parents']);
    const tables: CrossMediaTables = {
      async *rows(provider, table) {
        if (provider === 'vndb' && copyTables.has(table)) {
          yield* raw.rows(provider, table);
          return;
        }
        yield* sourceRows[`${provider}/${table}`] ?? [];
      },
    };
    const selected = await planCrossMediaSeed(tables, { deferVndbCharacterAppearances: true });
    const vocabulary = await planShowcaseCharacterVocabulary(tables, selected);
    expect(selected.franchises['steins-gate'].vndb).toEqual(['v1']);
    expect(vocabulary.plan.records.vndb.map((record) => record.key)).toEqual(['c1', 'c2']);
    expect(vocabulary.requirements.selectedWorkIds).toEqual(['v1', 'v2', 'v3']);
    expect(vocabulary.requirements.terms.map((term) => term.code).sort()).toEqual(['i10', 'i7', 'i73', 'main']);
    expect(vocabulary.requirements.terms.find((term) => term.code === 'i73')).toMatchObject({
      label: 'Silver hair',
      sourcePath: '/traits/i73',
      uri: characterTraitConceptUri('i73'),
    });
    expect(vocabulary.requirements.parents).toEqual([
      { childCode: 'i10', parentCode: 'i7', main: true, sourcePath: '/traits_parents/i10/i7' },
      { childCode: 'i73', parentCode: 'i10', main: true, sourcePath: '/traits_parents/i73/i10' },
    ]);
    expect(vocabulary.plan.gaps.some((gap) => gap.reason.includes('unsupported chars_vns.role'))).toBe(true);
    expect(vocabulary.plan.edges.some((edge) => edge.table === 'chars_vns')).toBe(false);

    const subject = (id: string, type: string, statements: Record<string, unknown>) => ({
      subject: { id, type, statements },
    });
    const subjects = new Map<string, object>([
      [traitSchemeId, subject(traitSchemeId, 'skos:ConceptScheme', { 'schema:url': [{ value: { content: characterTraitSchemeUri } }] })],
      [roleSchemeId, subject(roleSchemeId, 'skos:ConceptScheme', { 'schema:url': [{ value: { content: appearanceRoleSchemeUri } }] })],
      ...[...traitIds].map(([code, id]) => [
        id,
        subject(id, 'skos:Concept', {
          'schema:url': [{ value: { content: characterTraitConceptUri(code) } }],
          'skos:inScheme': [{ value: { content: traitSchemeId } }],
        }),
      ] as [string, object]),
      [mainRoleId, subject(mainRoleId, 'skos:Concept', {
        'schema:url': [{ value: { content: appearanceRoleConceptUri('main') } }],
        'skos:inScheme': [{ value: { content: roleSchemeId } }],
      })],
    ]);
    const reads: string[] = [];
    const port = {
      async readReviewedSubject(id: string) {
        reads.push(id);
        return (subjects.get(id) ?? { subject: { id } }) as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      },
    } as Pick<CrossMediaPort, 'readReviewedSubject'>;
    const profile = parseVndbCharacterVocabularyProfile({
      traits: { schemeId: traitSchemeId, concepts: [...traitIds].map(([code, id]) => ({ code, id })) },
      roles: { schemeId: roleSchemeId, concepts: [{ code: 'main', id: mainRoleId }] },
    });
    const bindings = await composeVndbCharacterVocabularyBindings(port, profile, vocabulary.requirements);
    expect(bindings.releaseDigest).toBe(bundledDigest);
    expect(bindings.concepts.map((concept) => concept.code).sort()).toEqual(['i10', 'i7', 'i73', 'main']);
    expect(reads).not.toContain(traitIds.get('i99'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
