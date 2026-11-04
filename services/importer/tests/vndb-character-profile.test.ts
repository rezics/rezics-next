import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import {
  vndbCharacterBloodTypeSchemeUri,
  vndbCharacterBloodTypeTaxonomy,
} from '@rezics/conversion/vndb-vocabulary';
import {
  CrossMediaDumpFiles,
  planCrossMediaSeed,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import {
  parseVndbCharacterProfileReferences,
  readVndbCharacterProfileBindings,
} from '../src/vndb-character-profile.ts';
import { seedShowcaseVndbReleases } from '../src/showcase-vndb-releases.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const charsHeader =
  'id\timage\tbloodt\tcup_size\tsex\tspoil_sex\tgender\tspoil_gender\tmain\tmain_spoil\ts_bust\ts_waist\ts_hip\tbirthday\theight\tweight\tage\tdescription';

function charsCopy(id: string, bloodt: string, gender: string, spoilGender: string, height: string, weight: string) {
  return [id, '\\N', bloodt, '\\N', '\\N', '\\N', gender, spoilGender, '\\N', '0', '\\N', '\\N', '\\N', '\\N', height, weight, '\\N', '\\N'].join('\t');
}

async function authoredTables(directory: string): Promise<CrossMediaTables> {
  const dump = join(directory, 'vndb');
  await mkdir(join(dump, 'db'), { recursive: true });
  await writeFile(join(dump, 'db/chars.header'), `${charsHeader}\n`);
  await writeFile(
    join(dump, 'db/chars'),
    `${charsCopy('c1', 'a', 'm', 'f', '157', '48')}\n${charsCopy('c2', 'unknown', 'o', 'a', '0', '\\N')}\n`,
  );
  const copy = new CrossMediaDumpFiles(directory, dump);
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 1, type: 2, name: 'STEINS;GATE' },
      { id: 2, type: 2, name: 'CLANNAD' },
      { id: 3, type: 2, name: 'Fate/stay night' },
    ],
    'vndb/vn_titles': [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    'vndb/vn': [
      { id: 'v1', olang: 'ja', alias: null },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/entry_meta': ['v1', 'v2', 'v3'].map((id) => ({ id, revision: '1', lastmod: '2026-11-04 00:00:00+00' })),
    'vndb/chars_vns': [
      { id: 'c1', vid: 'v1', rid: null, role: 'main', spoil: '0' },
      { id: 'c2', vid: 'v1', rid: null, role: 'side', spoil: '0' },
    ],
    'vndb/chars_names': [
      { id: 'c1', lang: 'ja', name: 'Authored heroine', latin: 'Heroine' },
      { id: 'c2', lang: 'ja', name: 'Authored side', latin: null },
    ],
    'vndb/chars_alias': [],
  };
  return {
    async *rows(provider, table) {
      if (provider === 'vndb' && table === 'chars') {
        yield* copy.rows(provider, table);
        return;
      }
      yield* (rows[`${provider}/${table}`] ?? []);
    },
  };
}

test('selected COPY characters retain identity and measurements while verified blood type becomes an ordinary source fact', async () => {
  const commands: BatchCommand[] = [];
  const metadata = sourceRecordMetadataFixture();
  const schemeId = randomUUID();
  const conceptId = randomUUID();
  const conceptUri = `${vndbCharacterBloodTypeSchemeUri}/a`;
  const subjects = new Map<string, string>();
  const port: CrossMediaPort = {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = randomUUID();
            subjects.set(id, command.subject.type);
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          return {
            key: command.key,
            status: 201 as const,
            value: command.op === 'propose' ? { candidate: randomUUID(), revision: 1 } : { revision: 1 },
          };
        }),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const subject =
        id === schemeId
          ? {
              id,
              type: 'skos:ConceptScheme',
              statements: { 'schema:url': [{ value: { content: vndbCharacterBloodTypeSchemeUri } }] },
            }
          : id === conceptId
            ? {
                id,
                type: 'skos:Concept',
                statements: {
                  'schema:url': [{ value: { content: conceptUri } }],
                  'skos:inScheme': [{ value: { content: schemeId } }],
                },
              }
            : { id, type: subjects.get(id), statements: {} };
      return { subject } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
  const references = parseVndbCharacterProfileReferences({ schemeId, concepts: [{ code: 'a', id: conceptId }] });
  const bindings = await readVndbCharacterProfileBindings(port, references);
  const schemeOnly = await readVndbCharacterProfileBindings(
    port,
    parseVndbCharacterProfileReferences({ schemeId, concepts: [] }),
  );
  expect(bindings.concepts.length).toBe(1);
  expect(bindings.concepts[0]?.taxonomy).toBe(vndbCharacterBloodTypeTaxonomy);
  expect(bindings.concepts[0]?.code).toBe('a');
  expect(bindings.concepts[0]?.id).toBe(conceptId);
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-profile-'));
  try {
    const tables = await authoredTables(directory);
    const plan = await planCrossMediaSeed(tables);
    const plannedCharacter = plan.entities.vndb.find((record) => record.key === 'c1')?.payload;
    expect(plannedCharacter?.height).toBe('157');
    expect(plannedCharacter?.weight).toBe('48');
    expect((plannedCharacter?.chars_names as Record<string, unknown>[])[0]?.name).toBe('Authored heroine');
    const statePath = join(directory, 'state.sqlite');
    const first = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: statePath,
      port,
      extras: {
        providers: ['vndb'],
        vndbCharacterProfileBindings: schemeOnly,
        mediaDeadlineMs: 0,
        recordConcurrency: 1,
      },
    });
    expect(first.vocabularyGaps.some((gap) => gap.path === '/chars/bloodt' && gap.reason === 'missing_concept')).toBe(true);
    expect(first.vndbCharacterProfileOmissions.some((row) => row.externalId === 'c2' && row.reason === 'source_unknown')).toBe(true);
    expect(first.vndbCharacterProfileOmissions.some((row) => row.externalId === 'c1' && row.field === 'gender')).toBe(true);
    expect(first.vndbCharacterProfileOmissions.some((row) => row.externalId === 'c1' && row.field === 'spoil_gender')).toBe(true);
    expect(
      commands.some(
        (command) => command.op === 'propose' && command.source.external_id === 'c1' && command.statement.property.id === 'wdt:P1853',
      ),
    ).toBe(false);
    const refreshed = await seedShowcaseVndbReleases({
      tables,
      plan,
      path: statePath,
      port,
      extras: {
        providers: ['vndb'],
        vndbCharacterProfileBindings: bindings,
        mediaDeadlineMs: 0,
        recordConcurrency: 1,
      },
    });
    expect(refreshed.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const blood = commands.find(
      (command) => command.op === 'propose' && command.source.external_id === 'c1' && command.statement.property.id === 'wdt:P1853',
    );
    if (blood?.op !== 'propose') throw new Error('Missing blood-type candidate');
    expect(blood.source.record_revision).toBe('unversioned');
    expect(blood.source.converter_revision).toBe(converter_revision);
    expect(blood.statement.value).toEqual({ type: 'value', content: conceptId });
    expect(JSON.stringify(blood.statement.references)).toContain('https://vndb.org/c1');
    expect(JSON.stringify(blood.statement.references)).toContain('/chars/bloodt');
    expect(commands.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:gender')).toBe(
      false,
    );
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'c1' &&
          command.statement.property.id === 'schema:height' &&
          JSON.stringify(command.statement.value).includes('157'),
      ),
    ).toBe(true);
    expect(commands.some((command) => command.op === 'propose' && command.source.external_id === 'c2' && command.statement.property.id === 'wdt:P1853')).toBe(
      false,
    );
    expect(refreshed.vndbCharacterProfileRequirements).toEqual([
      expect.objectContaining({ taxonomy: vndbCharacterBloodTypeTaxonomy, code: 'a' }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
