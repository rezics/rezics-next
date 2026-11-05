import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import {
  prepareShowcaseBangumiCharacterVocabulary,
  readShowcaseBangumiCharacterVocabulary,
} from '../../../importer/src/showcase-bangumi-characters.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const characterKindsUri = 'https://rezics.com/schemes/bangumi/character-kinds';

function sourceTables(): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 101, name: 'STEINS;GATE', type: 2 },
      { id: 102, name: 'STEINS;GATE 0', type: 2 },
      { id: 104, name: 'CLANNAD', type: 2 },
      { id: 105, name: 'Fate/stay night', type: 2 },
    ],
    'bangumi/subject-characters': [
      { subject_id: 101, character_id: 901, type: 1, order: 0 },
      { subject_id: 102, character_id: 901, type: 2, order: 4 },
    ],
    // Synthetic API-shaped row; the separately pinned official response is fixture evidence only.
    'bangumi/character': [
      {
        id: 901,
        name: 'Okabe Rintaro',
        name_cn: null,
        type: 1,
        infobox: [
          { key: '简体中文名', value: '冈部伦太郎' },
          {
            key: '别名',
            value: [
              { v: '未标记别名' },
              { k: '英文名', v: 'Hououin Kyouma' },
              { k: '英文名二', v: 'Unsupported English guess' },
            ],
          },
        ],
      },
    ],
    'vndb/vn': [
      { id: 'v1', olang: 'ja', alias: null },
      { id: 'v2', olang: 'ja', alias: null },
      { id: 'v3', olang: 'ja', alias: null },
    ],
    'vndb/vn_titles': [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    'vndb/entry_meta': [
      { id: 'v1', revision: '1' },
      { id: 'v2', revision: '1' },
      { id: 'v3', revision: '1' },
    ],
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function vocabularySubjectIds(journal: ShowcaseJournal): Map<string, string> {
  return new Map(
    journal
      .acknowledgedCommands()
      .flatMap(({ command, subjectId }) =>
        command.op === 'create' &&
        subjectId &&
        command.source.source === crossMediaAliases.bangumi &&
        command.source.converter_revision === 'bangumi-character-vocabulary@1'
          ? [[command.source.external_id, subjectId] as const]
          : [],
      ),
  );
}

function subjectStatements(read: Awaited<ReturnType<ReturnType<typeof createPublicBulkClient>['readSubject']>>) {
  return (
    read.subject as {
      statements: Record<string, { value: { content: unknown }; qualifiers?: unknown[]; references?: unknown[] }[]>;
    }
  ).statements;
}

test('selected anime character vocabulary is separately adopted and refreshed through the default adapter', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-characters-native-'));
  const statePath = join(directory, 'import.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  try {
    let port = captureShowcaseCommands(runtime.importTransport, journal);
    const editor = await openApiObserver(runtime);
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    const plan = await planCrossMediaSeed(sourceTables());
    expect(
      plan.characterAppearances?.map(({ subjectId, characterId, roleCode }) => [subjectId, characterId, roleCode]),
    ).toEqual([
      ['101', 901, 1],
      ['102', 901, 2],
    ]);
    const seed = (bindings?: SourceVocabularyBindings) =>
      seedCrossMedia(plan, statePath, port, { origin: runtime.origin }, {}, bindings);
    const first = await seed();
    const identities = new Map(
      first.readings.map((reading) => [reading.externalId, (reading.subject.subject as { id: string }).id]),
    );
    const workOneId = identities.get('101')!;
    const workTwoId = identities.get('102')!;
    const characterId = identities.get('character:901')!;
    expect(workOneId && workTwoId && characterId).toBeTruthy();

    const schemes = await prepareShowcaseBangumiCharacterVocabulary({ plan, port, journal, stage: 'schemes' });
    expect(schemes.bindings.schemes).toEqual([]);
    expect(
      (
        await publishShowcase({
          plan,
          result: first,
          aliases: crossMediaAliases,
          journal,
          review: runtime.importTransport,
          publicClient,
          vocabularyRequirements: schemes.requirements,
        })
      ).status,
    ).toBe('incomplete');

    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: schemes.requirements,
    });

    const concepts = await prepareShowcaseBangumiCharacterVocabulary({ plan, port, journal, stage: 'concepts' });
    expect(concepts.requirements.map(({ nativeType }) => nativeType)).toContain('skos:Concept');
    await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: concepts.requirements,
    });
    const bindings = await readShowcaseBangumiCharacterVocabulary({ plan, port, journal });
    const kind = bindings.concepts.find((entry) => entry.taxonomy === 'bangumi.character.role' && entry.code === '1')!;
    const main = bindings.concepts.find(
      (entry) => entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '1',
    )!;
    const supporting = bindings.concepts.find(
      (entry) => entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '2',
    )!;
    const kindSchemeId = bindings.schemes.find((entry) => entry.taxonomy === 'bangumi.character.role')!.id;
    expect(kind.id && main.id && supporting.id).toBeTruthy();

    const wrongScheme = {
      ...bindings,
      concepts: bindings.concepts.map((entry) =>
        entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '2'
          ? { ...entry, schemeId: kindSchemeId }
          : entry,
      ),
    };
    const withheld = await seed(wrongScheme);
    expect(withheld.characterDiagnostics).toContainEqual(
      expect.objectContaining({
        path: '/subject-characters/1/type',
        code: '2',
        reason: 'missing_concept',
        property: 'skos:Concept',
      }),
    );

    const refreshed = await seed(bindings);
    expect(refreshed.characterDiagnostics).toEqual([]);
    const published = await publishShowcase({
      plan,
      result: refreshed,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: concepts.requirements,
    });
    expect(published.status).toBe('published');

    const firstWork = subjectStatements(await publicClient.readSubject(workOneId));
    const secondWork = subjectStatements(await publicClient.readSubject(workTwoId));
    const character = subjectStatements(await publicClient.readSubject(characterId));
    expect(character['schema:name']?.map((statement) => statement.value.content)).toContainEqual({
      language: 'und',
      text: 'Okabe Rintaro',
    });
    const firstAppearance = firstWork['schema:character']?.find((statement) => statement.value.content === characterId);
    const secondAppearance = secondWork['schema:character']?.find(
      (statement) => statement.value.content === characterId,
    );
    expect(firstAppearance?.qualifiers).toContainEqual(
      expect.objectContaining({ property: { id: 'wdt:P3831' }, value: { content: main.id } }),
    );
    expect(secondAppearance?.qualifiers).toContainEqual(
      expect.objectContaining({ property: { id: 'wdt:P3831' }, value: { content: supporting.id } }),
    );
    expect(character['schema:keywords']?.map((statement) => statement.value.content)).toContain(kind.id);
    expect(JSON.stringify(firstAppearance?.references)).toContain(
      'https://bgm.tv/subject/101#/subject-characters/0/type',
    );

    const acknowledged = vocabularySubjectIds(journal);
    expect(acknowledged.get(characterKindsUri)).toBe(kindSchemeId);
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    port = captureShowcaseCommands(runtime.importTransport, journal);
    const reopenedBindings = await prepareShowcaseBangumiCharacterVocabulary({
      plan,
      port,
      journal,
      stage: 'concepts',
    });
    const reopened = await seed(await readShowcaseBangumiCharacterVocabulary({ plan, port, journal }));
    expect(reopened.characterDiagnostics).toEqual([]);
    expect(
      new Map(reopened.readings.map((reading) => [reading.externalId, (reading.subject.subject as { id: string }).id])),
    ).toEqual(identities);
    expect(vocabularySubjectIds(journal)).toEqual(acknowledged);
    const reopenedPublication = await publishShowcase({
      plan,
      result: reopened,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: reopenedBindings.requirements,
    });
    expect(reopenedPublication.status).toBe('published');
    expect(subjectStatements(await publicClient.readSubject(workOneId))['schema:character']).toHaveLength(1);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
