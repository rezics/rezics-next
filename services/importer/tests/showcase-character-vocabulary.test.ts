import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import {
  CrossMediaDumpFiles,
  planCrossMediaSeed,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  composeVndbCharacterVocabularyBindings,
  planShowcaseCharacterVocabulary,
  prepareShowcaseCharacterVocabulary,
  profileFromCharacterVocabularyBindings,
  readShowcaseCharacterVocabulary,
} from '../src/showcase-character-vocabulary.ts';
import {
  appearanceRoleSchemeUri,
  characterTraitConceptUri,
  characterTraitSchemeUri,
  importVndbCharacterTraits,
} from '../src/vndb-character-traits.ts';

async function selectedTables(directory: string, extraParents: string[] = []) {
  const vndb = join(directory, 'vndb');
  await mkdir(join(vndb, 'db'), { recursive: true });
  const copy = async (table: string, header: string, rows: string) => {
    await writeFile(join(vndb, 'db', `${table}.header`), `${header}\n`);
    await writeFile(join(vndb, 'db', table), rows);
  };
  await copy(
    'chars_traits',
    'id\ttid\tspoil\tlie',
    'c1\ti73\t1\tf\nc2\ti80\t0\tt\nc9\ti99\t0\tf\nc4\ti73\t0\tf\n',
  );
  await copy(
    'chars_vns',
    'id\tvid\trid\trole\tspoil',
    'c1\tv1\t\\N\tmain\t0\nc2\tv1\tr9\tside\t1\nc9\tv4\t\\N\tmain\t0\nc4\tv1\t\\N\tmain\t2\n',
  );
  await copy(
    'traits',
    'id\tgid\tgorder\tdefaultspoil\tsexual\tsearchable\tapplicable\tname\talias\tdescription',
    [
      'i73\ti10\t0\t0\tf\tt\tt\tSilver hair\t\\N\t\\N',
      'i10\ti7\t1\t0\tf\tt\tt\tHair\t\\N\t\\N',
      'i7\t\\N\t2\t0\tf\tt\tt\tAppearance\t\\N\t\\N',
      'i99\t\\N\t3\t0\tf\tt\tt\tUnrelated trait\t\\N\t\\N',
      ...extraParents.map((id, index) => `${id}\t\\N\t${index + 4}\t0\tf\tt\tt\tParent ${id}\t\\N\t\\N`),
    ].join('\n') + '\n',
  );
  await copy(
    'traits_parents',
    'id\tparent\tmain',
    ['i73\ti10\tt', 'i10\ti7\tt', ...extraParents.map((id, index) => `${index ? extraParents[index - 1] : 'i73'}\t${id}\tt`)].join(
      '\n',
    ) + '\n',
  );
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
      { id: 'c1', name: 'Selected character', main: null, bloodt: 'a' },
      { id: 'c2', name: 'Selected supporting character', main: null },
      { id: 'c4', name: 'Selected character', main: null, bloodt: 'o' },
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
  return tables;
}

function journaledPort(journal: ShowcaseJournal, commands: BatchCommand[]) {
  const metadata = sourceRecordMetadataFixture();
  const identities = new Map<string, string>();
  const subjects = new Map<string, { subject: { id: string; type: string; statements: Record<string, unknown[]> } }>();
  return {
    subjects,
    identities,
    async batch(request: { commands: BatchCommand[] }): Promise<BatchWriteResult> {
      commands.push(...request.commands);
      for (const command of request.commands) {
        if (command.op !== 'create' && command.op !== 'propose') continue;
        journal.prepareCommand(command);
      }
      const results = request.commands.map((command) => {
        if (command.op === 'create') {
          const id = identities.get(command.source.external_id) ?? randomUUID();
          identities.set(command.source.external_id, id);
          if (!subjects.has(id)) subjects.set(id, { subject: { id, type: command.subject.type, statements: {} } });
          return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
        }
        if (command.op === 'propose') {
          const subject = subjects.get(command.subject)?.subject;
          if (subject) {
            const statement = structuredClone(command.statement) as { value: { type: string; content: unknown } };
            const property = command.statement.property.id;
            subject.statements[property] =
              property === 'skos:broader'
                ? [...(subject.statements[property] ?? []), statement]
                : [statement];
          }
          return { key: command.key, status: 201 as const, value: { candidate: randomUUID(), revision: 1 } };
        }
        return { key: command.key, status: 201 as const, value: { revision: 1 } };
      });
      for (const [index, command] of request.commands.entries()) {
        if (command.op !== 'create' && command.op !== 'propose') continue;
        journal.acknowledgeCommand(
          command,
          results[index]! as Extract<BatchWriteResult['results'][number], { status: 200 | 201 }>,
        );
      }
      return { results } as BatchWriteResult;
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id: string) {
      const found = subjects.get(id);
      if (found) return found as ReviewedSubjectRead;
      return { subject: { id } } as ReviewedSubjectRead;
    },
  } satisfies CrossMediaPort & {
    subjects: Map<string, { subject: { id: string; type: string; statements: Record<string, unknown[]> } }>;
    identities: Map<string, string>;
  };
}

test('default seed publishes selected trait and role vocabulary without a UUID file and admits spoiler-qualified facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-character-vocabulary-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const commands: BatchCommand[] = [];
  const port = journaledPort(journal, commands);
  try {
    const tables = await selectedTables(directory);
    const selected = await planCrossMediaSeed(tables, { deferVndbCharacterAppearances: true });
    const vocabulary = await planShowcaseCharacterVocabulary(tables, selected);
    expect(selected.franchises['steins-gate'].vndb).toEqual(['v1']);
    expect(vocabulary.plan.records.vndb.map((record) => record.key)).toEqual(['c1', 'c2', 'c4']);
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
    expect(vocabulary.plan.gaps.some((gap) => gap.reason.includes('chars_traits.lie'))).toBe(true);
    expect(vocabulary.plan.gaps.some((gap) => gap.reason.includes('chars_vns.rid'))).toBe(true);
    expect(vocabulary.plan.edges.some((edge) => edge.table === 'chars_vns')).toBe(false);

    await prepareShowcaseCharacterVocabulary({
      tables,
      selectedPlan: selected,
      port,
      journal,
      stage: 'schemes',
    });
    const prepared = await prepareShowcaseCharacterVocabulary({
      tables,
      selectedPlan: selected,
      port,
      journal,
      stage: 'concepts',
    });
    expect(prepared.requirements.map((item) => [item.nativeType, item.sourceKey])).toEqual([
      ['skos:ConceptScheme', 'vndb.char_role'],
      ['skos:ConceptScheme', 'vndb.character-trait'],
      ['skos:Concept', 'vndb.character-trait:i73'],
      ['skos:Concept', 'vndb.char_role:main'],
      ['skos:Concept', 'vndb.character-trait:i10'],
      ['skos:Concept', 'vndb.character-trait:i7'],
    ]);
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:url' &&
          command.statement.value.content === characterTraitSchemeUri,
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'schema:url' &&
          command.statement.value.content === appearanceRoleSchemeUri,
      ),
    ).toBe(true);
    const current = await readShowcaseCharacterVocabulary({ tables, selectedPlan: selected, port, journal });
    expect(current.releaseDigest).toBe(bundledDigest);
    expect(current.concepts.map((concept) => concept.code).sort()).toEqual(['i10', 'i7', 'i73', 'main']);
    expect(current.concepts.find((concept) => concept.code === 'i73')?.type).toBe('skos:Concept');
    const hair = current.concepts.find((concept) => concept.code === 'i73')!;
    const hairSubject = port.subjects.get(hair.id)!.subject;
    expect(hairSubject.statements['schema:url']?.[0]).toMatchObject({
      value: { content: characterTraitConceptUri('i73') },
    });
    expect(JSON.stringify(hairSubject.statements['schema:url'])).toContain('https://vndb.org/i73');
    const parent = current.concepts.find((concept) => concept.code === 'i10')!;
    expect(hairSubject.statements['skos:broader']?.[0]).toMatchObject({ value: { content: parent.id } });

    const imported = await importVndbCharacterTraits({
      tables,
      path: join(directory, 'state.sqlite'),
      port,
      bindings: current,
      selectedWorkIds: vocabulary.requirements.selectedWorkIds,
    });
    const proposed = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> => command.op === 'propose',
    );
    const content = (command: Extract<BatchCommand, { op: 'propose' }>) =>
      command.statement.value.type === 'value' ? command.statement.value.content : undefined;
    const keywords = proposed.filter((command) => command.statement.property.id === 'schema:keywords');
    const appearances = proposed.filter((command) => command.statement.property.id === 'schema:character');
    expect(new Set(keywords.map(content))).toEqual(new Set([hair.id]));
    expect(
      keywords
        .find((command) => JSON.stringify(command).includes('/chars_traits/c1/i73'))
        ?.statement.qualifiers?.find((term) => term.property.id === 'rezics:spoilerLevel')?.value,
    ).toEqual({ type: 'value', content: { amount: '+1', unit: '1' } });
    expect(JSON.stringify(keywords)).toContain('/chars_traits/c1/i73');
    const mainRole = current.concepts.find((concept) => concept.code === 'main')!;
    expect(appearances.some((command) => content(command) !== undefined)).toBe(true);
    expect(JSON.stringify(appearances)).toContain(mainRole.id);
    expect(JSON.stringify(appearances)).toContain('/chars_vns/c1/v1');
    expect(JSON.stringify(appearances)).not.toContain('/chars_vns/c2/v1/r9');
    expect(imported.status).toBe('imported-with-gaps');

    const before = [...current.concepts].sort((left, right) => left.code.localeCompare(right.code));
    const createIds = new Map(port.identities);
    await prepareShowcaseCharacterVocabulary({
      tables,
      selectedPlan: selected,
      port,
      journal,
      stage: 'concepts',
    });
    const rerun = await readShowcaseCharacterVocabulary({ tables, selectedPlan: selected, port, journal });
    expect([...rerun.concepts].sort((left, right) => left.code.localeCompare(right.code))).toEqual(before);
    expect(port.identities.get('vocabulary:vndb.character-trait:i73')).toBe(createIds.get('vocabulary:vndb.character-trait:i73'));
    const again = await importVndbCharacterTraits({
      tables,
      path: join(directory, 'state.sqlite'),
      port,
      bindings: rerun,
      selectedWorkIds: vocabulary.requirements.selectedWorkIds,
    });
    expect(again.runs.vndb?.counts.unchanged).toBeGreaterThan(0);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('lying, release-scoped, retracted and parent-contradictory rows withhold only the affected associations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-character-vocabulary-gaps-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const commands: BatchCommand[] = [];
  const port = journaledPort(journal, commands);
  try {
    const tables = await selectedTables(directory);
    const selected = await planCrossMediaSeed(tables, { deferVndbCharacterAppearances: true });
    await prepareShowcaseCharacterVocabulary({
      tables,
      selectedPlan: selected,
      port,
      journal,
      stage: 'schemes',
    });
    await prepareShowcaseCharacterVocabulary({
      tables,
      selectedPlan: selected,
      port,
      journal,
      stage: 'concepts',
    });
    const current = await readShowcaseCharacterVocabulary({ tables, selectedPlan: selected, port, journal });
    const hair = current.concepts.find((concept) => concept.code === 'i73')!;
    const parent = current.concepts.find((concept) => concept.code === 'i10')!;
    const role = current.concepts.find((concept) => concept.code === 'main')!;
    await importVndbCharacterTraits({
      tables,
      path: join(directory, 'state.sqlite'),
      port,
      bindings: current,
      selectedWorkIds: ['v1', 'v2', 'v3'],
    });
    const createdCharacters = [...port.identities.entries()].filter(([key]) => key.startsWith('c'));
    expect(new Set(createdCharacters.map(([key]) => key))).toEqual(new Set(['c1', 'c2', 'c4']));
    expect(port.identities.get('c1')).not.toBe(port.identities.get('c4'));
    const firstKeywords = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'schema:keywords',
    );
    expect(firstKeywords.some((command) => command.statement.value.content === hair.id)).toBe(true);

    const hairSubject = port.subjects.get(hair.id)!.subject;
    hairSubject.statements['schema:url'] = [{ value: { content: 'https://rezics.com/schemes/vndb/character-traits/other' } }];
    const withheldUri = await readShowcaseCharacterVocabulary({ tables, selectedPlan: selected, port, journal });
    expect(withheldUri.concepts.map((concept) => concept.code).sort()).toEqual(['i10', 'i7', 'main']);
    hairSubject.statements['schema:url'] = [{ value: { content: characterTraitConceptUri('i73') } }];
    hairSubject.statements['skos:inScheme'] = [{ value: { content: role.schemeId } }];
    const withheldScheme = await composeVndbCharacterVocabularyBindings(
      port,
      profileFromCharacterVocabularyBindings(current),
      (await planShowcaseCharacterVocabulary(tables, selected)).requirements,
    );
    expect(withheldScheme.concepts.some((concept) => concept.code === 'i73')).toBe(false);
    hairSubject.statements['skos:inScheme'] = [{ value: { content: current.schemes.find((scheme) => scheme.taxonomy === 'vndb.character-trait')!.id } }];
    hairSubject.statements['skos:broader'] = [{ value: { content: role.id } }];
    const withheldParent = await readShowcaseCharacterVocabulary({ tables, selectedPlan: selected, port, journal });
    expect(withheldParent.concepts.map((concept) => concept.code).sort()).toEqual(['i10', 'i7', 'main']);
    hairSubject.statements['skos:broader'] = [{ value: { content: parent.id } }];

    const afterCount = commands.length;
    await importVndbCharacterTraits({
      tables,
      path: join(directory, 'state.sqlite'),
      port,
      bindings: withheldParent,
      selectedWorkIds: ['v1', 'v2', 'v3'],
    });
    const laterKeywords = commands
      .slice(afterCount)
      .filter(
        (command): command is Extract<BatchCommand, { op: 'propose' }> =>
          command.op === 'propose' && command.statement.property.id === 'schema:keywords',
      );
    expect(laterKeywords.filter((command) => command.statement.value.content === hair.id)).toEqual([]);
    expect(port.identities.get('c1')).toBe(createdCharacters.find(([key]) => key === 'c1')?.[1]);
    expect(JSON.stringify(commands.filter((command) => command.op === 'propose' && command.statement.property.id === 'schema:character'))).not.toContain(
      '/chars_vns/c2/v1/r9',
    );

    const overflowParents = Array.from({ length: 14 }, (_, index) => `i${2000 + index}`);
    const overflowTables = await selectedTables(join(directory, 'overflow'), overflowParents);
    const overflowed = await prepareShowcaseCharacterVocabulary({
      tables: overflowTables,
      selectedPlan: selected,
      port,
      journal,
      stage: 'concepts',
    });
    expect(overflowed.truncated).toBe(true);
    expect(overflowed.requirements.some((item) => item.sourceKey.endsWith(':i73'))).toBe(true);
    expect(overflowed.requirements.some((item) => item.sourceKey.endsWith(':i2013'))).toBe(false);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
