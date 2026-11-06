import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import type { CrossMediaPort } from '../src/cross-media-seed.ts';
import { CrossMediaDumpFiles } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { importVndbCharacterTraits } from '../src/selected-import.ts';
import {
  appearanceRoleConceptUri,
  appearanceRoleSchemeUri,
  characterTraitConceptUri,
  characterTraitSchemeUri,
  planVndbCharacterTraits,
  readVndbCharacterVocabularyBindings,
  VNDB_CHARACTER_APPEARANCE_COLUMNS,
  VNDB_CHARACTER_TRAIT_COLUMNS,
} from '../src/vndb-character-traits.ts';

function authoredTables() {
  const rows: Record<string, Record<string, unknown>[]> = {
    'vndb/vn': [{ id: 'v1', olang: 'ja', alias: null }],
    'vndb/vn_titles': [{ id: 'v1', lang: 'ja', official: 't', title: 'Authored visual novel', latin: null }],
    'vndb/entry_meta': [{ id: 'v1', revision: '1', lastmod: '2026-10-25 00:00:00+00' }],
    'vndb/chars': [
      { id: 'c1', name: 'Authored heroine', main: 'c3', main_spoil: '1' },
      { id: 'c2', name: 'Authored side character', main: null },
      { id: 'c3', name: 'Authored main version', main: null },
    ],
    'vndb/chars_traits': [
      { id: 'c1', tid: 'i73', spoil: '1', lie: 'f' },
      { id: 'c2', tid: 'i80', spoil: '0', lie: 't' },
    ],
    'vndb/chars_vns': [
      { id: 'c1', vid: 'v1', rid: null, role: 'main', spoil: '0' },
      { id: 'c2', vid: 'v1', rid: 'r9', role: 'side', spoil: '1' },
    ],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

const traitSchemeId = '00000000-0000-4000-8000-000000000090';
const hairId = '00000000-0000-4000-8000-000000000091';
const roleSchemeId = '00000000-0000-4000-8000-000000000092';
const mainRoleId = '00000000-0000-4000-8000-000000000093';
const subjects: Record<string, object> = {
  [traitSchemeId]: {
    subject: {
      id: traitSchemeId,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: characterTraitSchemeUri } }] },
    },
  },
  [hairId]: {
    subject: {
      id: hairId,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: characterTraitConceptUri('i73') } }],
        'skos:inScheme': [{ value: { content: traitSchemeId } }],
      },
    },
  },
  [roleSchemeId]: {
    subject: {
      id: roleSchemeId,
      type: 'skos:ConceptScheme',
      statements: { 'schema:url': [{ value: { content: appearanceRoleSchemeUri } }] },
    },
  },
  [mainRoleId]: {
    subject: {
      id: mainRoleId,
      type: 'skos:Concept',
      statements: {
        'schema:url': [{ value: { content: appearanceRoleConceptUri('main') } }],
        'skos:inScheme': [{ value: { content: roleSchemeId } }],
      },
    },
  },
};

function port(commands: BatchCommand[]): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? { id: randomUUID(), revision: 1 }
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const known = subjects[id];
      if (!known) return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
      return known as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

test('operator plans authored COPY character traits and imports exact supported facts through the seed caller', async () => {
  expect([...VNDB_CHARACTER_TRAIT_COLUMNS]).toEqual(['id', 'tid', 'spoil', 'lie']);
  expect([...VNDB_CHARACTER_APPEARANCE_COLUMNS]).toEqual(['id', 'vid', 'rid', 'role', 'spoil']);
  const plan = await planVndbCharacterTraits(authoredTables());
  expect(plan.records.vndb.map((row) => row.key)).toEqual(['c1', 'c2', 'c3']);
  expect(plan.entities.vndb.map((row) => row.key)).toEqual(['v1']);
  expect(plan.edges).toEqual([]);
  expect(plan.gaps.some((gap) => gap.reason.includes('chars_traits.lie'))).toBe(true);
  expect(plan.gaps.some((gap) => gap.reason.includes('chars_vns.rid'))).toBe(true);
  expect(plan.gaps.some((gap) => gap.reason.includes('chars.main'))).toBe(true);
  const commands: BatchCommand[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-traits-'));
  try {
    const dump = join(directory, 'dump');
    await mkdir(join(dump, 'db'), { recursive: true });
    await writeFile(join(dump, 'db/chars_traits.header'), `${VNDB_CHARACTER_TRAIT_COLUMNS.join('\t')}\n`);
    await writeFile(join(dump, 'db/chars_traits'), 'c1\ti73\t1\tf\nc2\ti80\t0\tt\n');
    await writeFile(join(dump, 'db/chars_vns.header'), `${VNDB_CHARACTER_APPEARANCE_COLUMNS.join('\t')}\n`);
    await writeFile(join(dump, 'db/chars_vns'), 'c1\tv1\t\\N\tmain\t0\nc2\tv1\tr9\tside\t1\n');
    const copyRows = new CrossMediaDumpFiles(dump, dump);
    const copyTraits = await Array.fromAsync(copyRows.rows('vndb', 'chars_traits'));
    expect(copyTraits).toEqual([
      { id: 'c1', tid: 'i73', spoil: '1', lie: 'f' },
      { id: 'c2', tid: 'i80', spoil: '0', lie: 't' },
    ]);
    const bindings = await readVndbCharacterVocabularyBindings(port(commands), {
      traits: { schemeId: traitSchemeId, concepts: [{ code: 'i73', id: hairId }] },
      roles: { schemeId: roleSchemeId, concepts: [{ code: 'main', id: mainRoleId }] },
    });
    expect(bindings.concepts.map((item) => item.code).sort()).toEqual(['i73', 'main']);
    const first = await importVndbCharacterTraits({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(first.status).toBe('imported-with-gaps');
    expect(first.converterRevision).toBe(converter_revision);
    const proposed = commands.filter((command) => command.op === 'propose');
    const content = (command: (typeof proposed)[number]) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    expect(
      proposed.some((command) => command.statement.property.id === 'schema:keywords' && content(command) === hairId),
    ).toBe(true);
    expect(
      proposed.some(
        (command) => command.statement.property.id === 'schema:character' && content(command) !== undefined,
      ),
    ).toBe(true);
    expect(
      proposed.some((command) => command.statement.property.id === 'schema:keywords' && content(command) !== hairId),
    ).toBe(false);
    expect(JSON.stringify(proposed)).not.toContain('sameCharacters');
    const count = commands.length;
    const again = await importVndbCharacterTraits({
      tables: authoredTables(),
      path: join(directory, 'state.sqlite'),
      port: port(commands),
      bindings,
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThanOrEqual(count);
    subjects[hairId] = { subject: { id: hairId, type: 'skos:Concept', statements: {} } };
    const withheld = await readVndbCharacterVocabularyBindings(port([]), {
      traits: { schemeId: traitSchemeId, concepts: [{ code: 'i73', id: hairId }] },
      roles: { schemeId: roleSchemeId, concepts: [{ code: 'main', id: mainRoleId }] },
    });
    expect(withheld.concepts.some((item) => item.id === hairId)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
