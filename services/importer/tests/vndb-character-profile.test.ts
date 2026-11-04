import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/cross-media-entities';
import { vndbCharacterBloodTypeSchemeUri, vndbCharacterBloodTypeTaxonomy } from '@rezics/conversion/vndb-vocabulary';
import {
  CrossMediaDumpFiles,
  planCrossMediaSeed,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import {
  parseVndbCharacterProfileReferences,
  prepareShowcaseVndbCharacterProfileVocabulary,
  readShowcaseVndbCharacterProfileVocabulary,
  readVndbCharacterProfileBindings,
  vndbCharacterBloodTypeConceptUri,
} from '../src/vndb-character-profile.ts';
import { seedShowcaseVndbReleases } from '../src/showcase-vndb-releases.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../src/showcase-publication.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const charsHeader =
  'id\timage\tbloodt\tcup_size\tsex\tspoil_sex\tgender\tspoil_gender\tmain\tmain_spoil\ts_bust\ts_waist\ts_hip\tbirthday\theight\tweight\tage\tdescription';

function charsCopy(
  id: string,
  bloodt: string,
  gender: string,
  spoilGender: string,
  height: string,
  weight: string,
) {
  return [
    id,
    '\\N',
    bloodt,
    '\\N',
    '\\N',
    '\\N',
    gender,
    spoilGender,
    '\\N',
    '0',
    '\\N',
    '\\N',
    '\\N',
    '\\N',
    height,
    weight,
    '\\N',
    '\\N',
  ].join('\t');
}

async function authoredTables(
  directory: string,
  extra: string[] = [],
): Promise<CrossMediaTables> {
  const dump = join(directory, 'vndb');
  await mkdir(join(dump, 'db'), { recursive: true });
  await writeFile(join(dump, 'db/chars.header'), `${charsHeader}\n`);
  await writeFile(
    join(dump, 'db/chars'),
    `${charsCopy('c1', 'a', 'm', 'f', '157', '48')}\n${charsCopy('c2', 'unknown', 'o', 'a', '0', '\\N')}\n${extra.join('\n')}${extra.length ? '\n' : ''}`,
  );
  const copy = new CrossMediaDumpFiles(directory, dump);
  const appearances = [
    { id: 'c1', vid: 'v1', rid: null, role: 'main', spoil: '0' },
    { id: 'c2', vid: 'v1', rid: null, role: 'side', spoil: '0' },
    ...extra.map((row) => ({ id: row.split('\t')[0]!, vid: 'v1', rid: null, role: 'side', spoil: '0' })),
  ];
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
    'vndb/chars_vns': appearances,
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
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function journalPort(commands: BatchCommand[]) {
  type Subject = {
    subject: {
      id: string;
      type: string;
      labels: Record<string, string>;
      statements: Record<string, { value: { content: unknown }; references?: unknown }[]>;
    };
  };
  const subjects = new Map<string, Subject>();
  const metadata = sourceRecordMetadataFixture();
  const port: CrossMediaPort = {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = randomUUID();
            subjects.set(id, {
              subject: { id, type: command.subject.type, labels: command.subject.labels, statements: {} },
            });
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          if (command.op === 'propose') {
            const subject = subjects.get(command.subject);
            const value = command.statement.value;
            if (subject && value.type === 'value') {
              const rows = subject.subject.statements[command.statement.property.id] ?? [];
              rows.push({
                value: { content: value.content },
                ...(command.statement.references ? { references: command.statement.references } : {}),
              });
              subject.subject.statements[command.statement.property.id] = rows;
            }
            return { key: command.key, status: 201 as const, value: { candidate: randomUUID(), revision: 1 } };
          }
          return { key: command.key, status: 201 as const, value: { revision: 1 } };
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
      return (subjects.get(id) ?? { subject: { id, type: undefined, statements: {} } }) as unknown as Awaited<
        ReturnType<CrossMediaPort['readReviewedSubject']>
      >;
    },
  };
  return { port, subjects };
}

function seedArgs(
  tables: CrossMediaTables,
  plan: Awaited<ReturnType<typeof planCrossMediaSeed>>,
  path: string,
  port: CrossMediaPort,
  bindings?: Awaited<ReturnType<typeof readVndbCharacterProfileBindings>>,
) {
  return {
    tables,
    plan,
    path,
    port,
    extras: {
      providers: ['vndb'] as const,
      ...(bindings ? { vndbCharacterProfileBindings: bindings } : {}),
      mediaDeadlineMs: 0,
      recordConcurrency: 1,
    },
  };
}

test('default showcase without a profile file publishes selected blood types and keeps them across both seed phases', async () => {
  const commands: BatchCommand[] = [];
  const { port, subjects } = journalPort(commands);
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-profile-'));
  const journalPath = join(directory, 'showcase.sqlite');
  const journal = new ShowcaseJournal(journalPath);
  const captured = captureShowcaseCommands(port, journal);
  try {
    const tables = await authoredTables(directory);
    const plan = await planCrossMediaSeed(tables);
    const planned = plan.entities.vndb.find((record) => record.key === 'c1')?.payload;
    expect(planned?.height).toBe('157');
    expect(planned?.weight).toBe('48');
    expect((planned?.chars_names as Record<string, unknown>[])[0]?.name).toBe('Authored heroine');
    const statePath = join(directory, 'state.sqlite');
    const first = await seedShowcaseVndbReleases(seedArgs(tables, plan, statePath, captured));
    const heroineId = first.readings.find((row) => row.externalId === 'c1')?.subject.subject.id;
    expect(heroineId).toBeDefined();
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'c1' &&
          command.statement.property.id === 'wdt:P1853',
      ),
    ).toBe(false);

    const schemes = await prepareShowcaseVndbCharacterProfileVocabulary({
      plan,
      port: captured,
      journal,
      stage: 'schemes',
    });
    expect(schemes.requirements).toEqual([
      expect.objectContaining({ nativeType: 'skos:ConceptScheme', sourceUri: vndbCharacterBloodTypeSchemeUri }),
    ]);
    const concepts = await prepareShowcaseVndbCharacterProfileVocabulary({
      plan,
      port: captured,
      journal,
      stage: 'concepts',
    });
    expect(concepts.requirements.map((requirement) => requirement.sourceKey).sort()).toEqual([
      vndbCharacterBloodTypeTaxonomy,
      `${vndbCharacterBloodTypeTaxonomy}:a`,
    ]);
    const bindings = await readShowcaseVndbCharacterProfileVocabulary({ plan, port: captured, journal });
    expect(bindings.concepts.map((concept) => concept.code)).toEqual(['a']);
    expect(bindings.schemes[0]?.uri).toBe(vndbCharacterBloodTypeSchemeUri);

    const second = await seedShowcaseVndbReleases(seedArgs(tables, plan, statePath, captured, bindings));
    expect(second.readings.find((row) => row.externalId === 'c1')?.subject.subject.id).toBe(heroineId);
    expect(second.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
    const blood = commands.find(
      (command) =>
        command.op === 'propose' &&
        command.source.external_id === 'c1' &&
        command.statement.property.id === 'wdt:P1853',
    );
    if (blood?.op !== 'propose') throw new Error('Missing blood-type candidate');
    expect(blood.source.record_revision).toBe('unversioned');
    expect(blood.source.converter_revision).toBe(converter_revision);
    expect(blood.statement.value).toEqual({ type: 'value', content: bindings.concepts[0]?.id });
    expect(JSON.stringify(blood.statement.references)).toContain('https://vndb.org/c1');
    expect(JSON.stringify(blood.statement.references)).toContain('/chars/bloodt');
    const heroine = subjects.get(heroineId!);
    expect(heroine?.subject.type).toBe('wd:Q95074');
    expect(heroine?.subject.statements['wdt:P1853']?.[0]?.value.content).toBe(bindings.concepts[0]?.id);
    expect(JSON.stringify(heroine?.subject.statements['wdt:P1853']?.[0]?.references)).toContain('/chars/bloodt');
    expect(JSON.stringify(heroine?.subject.statements['schema:height'])).toContain('157');
    expect(JSON.stringify(heroine?.subject.statements['schema:name'])).toContain('Authored heroine');
    expect(second.vndbCharacterProfileRequirements).toEqual([
      expect.objectContaining({ taxonomy: vndbCharacterBloodTypeTaxonomy, code: 'a' }),
    ]);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown, malformed, withheld gender, refused Concepts and interrupted sends keep independent profile facts', async () => {
  const commands: BatchCommand[] = [];
  const { port, subjects } = journalPort(commands);
  const directory = await mkdtemp(join(tmpdir(), 'vndb-character-profile-edge-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const malformed = charsCopy('c3', 'x'.repeat(65), '', '', '0', '\\N');
  const typeB = charsCopy('c4', 'b', '', '', '0', '\\N');
  let loseFirstDelivery = true;
  const refusing = {
    ...port,
    async batch(request: Parameters<CrossMediaPort['batch']>[0]) {
      if (loseFirstDelivery) {
        loseFirstDelivery = false;
        throw new Error('lost delivery');
      }
      const denied = new Set(
        request.commands.flatMap((command) =>
          command.op === 'create' && JSON.stringify(command.subject.labels) === JSON.stringify({ und: 'b' })
            ? [command.key]
            : [],
        ),
      );
      const allowed = request.commands.filter((command) => !denied.has(command.key));
      const delivered = allowed.length ? await port.batch({ commands: allowed }) : { results: [] };
      const byKey = new Map(delivered.results.map((entry) => [entry.key, entry]));
      return {
        results: request.commands.map((command) =>
          denied.has(command.key)
            ? {
                key: command.key,
                status: 403 as const,
                problem: { type: 'about:blank', title: 'refused', status: 403 },
              }
            : byKey.get(command.key)!,
        ),
      };
    },
  };
  let captured = captureShowcaseCommands(refusing, journal);
  try {
    const tables = await authoredTables(directory, [malformed, typeB]);
    const plan = await planCrossMediaSeed(tables);
    const statePath = join(directory, 'state.sqlite');
    let lost = false;
    try {
      await prepareShowcaseVndbCharacterProfileVocabulary({
        plan,
        port: captured,
        journal,
        stage: 'schemes',
      });
    } catch (error) {
      lost = error instanceof Error && error.message === 'lost delivery';
    }
    expect(lost).toBe(true);
    const sealed = journal.preparedCommands().map((row) => row.command);
    expect(sealed.length).toBeGreaterThan(0);
    const recovered = await prepareShowcaseVndbCharacterProfileVocabulary({
      plan,
      port: captured,
      journal,
      stage: 'schemes',
    });
    expect(journal.preparedCommands()).toHaveLength(0);
    expect(recovered.requirements[0]?.nativeType).toBe('skos:ConceptScheme');
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    captured = captureShowcaseCommands(refusing, journal);
    const concepts = await prepareShowcaseVndbCharacterProfileVocabulary({
      plan,
      port: captured,
      journal,
      stage: 'concepts',
    });
    expect(concepts.issues.some((issue) => issue.outcome === 'refused')).toBe(true);
    const bindings = await readShowcaseVndbCharacterProfileVocabulary({ plan, port: captured, journal });
    expect(bindings.concepts.map((concept) => concept.code)).toEqual(['a']);
    const concept = subjects.get(bindings.concepts[0]!.id)!;
    concept.subject.statements['skos:inScheme'] = [{ value: { content: randomUUID() } }];
    const withheld = await readVndbCharacterProfileBindings(
      captured,
      parseVndbCharacterProfileReferences({
        schemeId: bindings.schemes[0]!.id,
        concepts: [{ code: 'a', id: bindings.concepts[0]!.id }],
      }),
    );
    expect(withheld.concepts).toEqual([]);

    const first = await seedShowcaseVndbReleases(seedArgs(tables, plan, statePath, captured, withheld));
    expect(first.vndbCharacterProfileOmissions.some((row) => row.externalId === 'c2' && row.reason === 'source_unknown')).toBe(
      true,
    );
    expect(first.vndbCharacterProfileOmissions.some((row) => row.externalId === 'c3' && row.reason === 'invalid_source_value')).toBe(
      true,
    );
    expect(first.vndbCharacterProfileOmissions.some((row) => row.externalId === 'c1' && row.field === 'gender')).toBe(
      true,
    );
    expect(
      first.vndbCharacterProfileOmissions.some((row) => row.externalId === 'c1' && row.field === 'spoil_gender'),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === 'c1' &&
          command.statement.property.id === 'wdt:P1853',
      ),
    ).toBe(false);
    expect(
      commands.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:gender'),
    ).toBe(false);
    const heroineId = first.readings.find((row) => row.externalId === 'c1')?.subject.subject.id;
    const second = await seedShowcaseVndbReleases(seedArgs(tables, plan, statePath, captured, withheld));
    expect(second.readings.find((row) => row.externalId === 'c1')?.subject.subject.id).toBe(heroineId);
    expect(JSON.stringify(subjects.get(heroineId!)?.subject.statements['schema:height'])).toContain('157');
    expect(JSON.stringify(subjects.get(heroineId!)?.subject.statements['schema:name'])).toContain('Authored heroine');
    expect(second.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
