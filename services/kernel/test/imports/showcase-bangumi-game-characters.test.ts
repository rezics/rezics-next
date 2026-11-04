import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPlan,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import {
  prepareShowcaseBangumiGameCharacterVocabulary,
  readShowcaseBangumiGameCharacterVocabulary,
} from '../../../importer/src/showcase-bangumi-game-characters.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const appearanceRolesUri = 'https://rezics.com/schemes/bangumi/appearance-roles';

function sourceTables(order: unknown): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 101, name: 'STEINS;GATE', type: 2 },
      { id: 103, name: 'STEINS;GATE Game', type: 4 },
      { id: 104, name: 'CLANNAD', type: 2 },
      { id: 105, name: 'Fate/stay night', type: 2 },
      { id: 201, name: 'Unrelated Game', type: 4 },
    ],
    'bangumi/subject-characters': [
      { subject_id: 101, character_id: 901, type: 1, order: 0 },
      { subject_id: 103, character_id: 902, type: 1, order },
      { subject_id: 103, character_id: 903, type: 2, order: 1 },
      { subject_id: 201, character_id: 902, type: 1, order: 0 },
    ],
    'bangumi/person-characters': [
      { subject_id: 103, person_id: 1001, character_id: 902, creditedAs: 'Voice A' },
      { subject_id: 103, person_id: 1002, character_id: 903, creditedAs: 'Voice B' },
      { subject_id: 201, person_id: 1003, character_id: 902, creditedAs: 'Unrelated Voice' },
    ],
    'bangumi/character': [
      { id: 901, name: 'Anime Character', type: 1 },
      { id: 902, name: 'Game Character A', type: 1 },
      { id: 903, name: 'Game Character B', type: 2 },
    ],
    'bangumi/person': [
      { id: 1001, name: 'Voice A', type: 1 },
      { id: 1002, name: 'Voice B', type: 1 },
      { id: 1003, name: 'Unrelated Voice', type: 1 },
    ],
    'vndb/vn': ['v1', 'v2', 'v3'].map((id) => ({ id, olang: 'ja', alias: null })),
    'vndb/vn_titles': [
      { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null },
      { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null },
      { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null },
    ],
    'vndb/entry_meta': ['v1', 'v2', 'v3'].map((id) => ({ id, revision: '1' })),
  };
  return {
    async *rows(provider, table) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function subjectStatements(read: Awaited<ReturnType<ReturnType<typeof createPublicBulkClient>['readSubject']>>) {
  return read.subject as {
    id: string;
    type: string;
    statements: Record<
      string,
      {
        id?: string;
        value: { content: unknown };
        qualifiers?: { property: { id: string }; value: { content: unknown } }[];
        references?: unknown[];
      }[]
    >;
  };
}

function activeRequirements(
  requirements: Awaited<ReturnType<typeof prepareShowcaseBangumiGameCharacterVocabulary>>['requirements'],
  bindings: SourceVocabularyBindings,
) {
  const current = new Set(bindings.concepts.map(({ taxonomy, code }) => `${taxonomy}:${code}`));
  return requirements.filter((entry) => entry.nativeType === 'skos:ConceptScheme' || current.has(entry.sourceKey));
}

function identityReads(result: { readings: { externalId: string; subject: unknown }[] }): Map<string, string> {
  return new Map(
    result.readings.map((reading) => [reading.externalId, (reading.subject as { subject: { id: string } }).subject.id]),
  );
}

test('selected Game characters and performers publish through current bindings and keep identities on corrected refresh', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-game-characters-native-'));
  const statePath = join(directory, 'import.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  const journal = new ShowcaseJournal(journalPath);
  try {
    const port = captureShowcaseCommands(runtime.importTransport, journal);
    const editor = await openApiObserver(runtime);
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    const malformedPlan = await planCrossMediaSeed(sourceTables('unknown'));
    expect(malformedPlan.gameCharacterAppearances?.map(({ subjectId }) => subjectId)).toEqual(['103', '103']);
    const first = await seedCrossMedia(
      malformedPlan,
      statePath,
      port,
      { origin: runtime.origin },
      { providers: ['bangumi'] },
    );
    const acknowledged = identityReads(first);
    expect(acknowledged.has('103')).toBe(true);
    expect(acknowledged.has('character:902')).toBe(true);
    expect(acknowledged.has('character:903')).toBe(true);
    expect(acknowledged.has('person:1001')).toBe(true);
    expect(acknowledged.has('person:1002')).toBe(true);
    expect(acknowledged.has('person:1003')).toBe(false);

    const schemes = await prepareShowcaseBangumiGameCharacterVocabulary({
      plan: malformedPlan,
      port,
      journal,
      stage: 'schemes',
    });
    expect(schemes.bindings.schemes).toEqual([]);
    await publishShowcase({
      plan: malformedPlan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: schemes.requirements,
    });
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    await publishShowcase({
      plan: malformedPlan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: schemes.requirements,
    });

    const concepts = await prepareShowcaseBangumiGameCharacterVocabulary({
      plan: malformedPlan,
      port,
      journal,
      stage: 'concepts',
    });
    expect(concepts.requirements.map(({ nativeType }) => nativeType)).toContain('skos:Concept');
    await publishShowcase({
      plan: malformedPlan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: concepts.requirements,
    });
    const bindings = await readShowcaseBangumiGameCharacterVocabulary({ plan: malformedPlan, port, journal });
    const roleTwo = bindings.concepts.find(
      (entry) => entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '2',
    )!;
    expect(roleTwo).toBeDefined();

    const params = new URLSearchParams({ property: 'schema:url', context: GLOBAL_CONTEXT, limit: '100' });
    const candidates = await editor.http(`/v1/subjects/${roleTwo.id}/candidates?${params}`);
    const roleTwoUrl = (
      candidates.body as {
        candidates: { id: string; source?: unknown; statement: { value: { content: unknown } } }[];
      }
    ).candidates.find(
      (candidate) => candidate.source && candidate.statement.value.content === `${appearanceRolesUri}/2`,
    );
    expect(roleTwoUrl).toBeDefined();
    const retracted = await editor.http(`/v1/statements/${roleTwoUrl!.id}/retract`, {});
    expect(retracted.status).toBe(200);

    const currentBindings = await readShowcaseBangumiGameCharacterVocabulary({ plan: malformedPlan, port, journal });
    expect(
      currentBindings.concepts.some(
        (entry) => entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '2',
      ),
    ).toBe(false);
    const malformedRefresh = await seedCrossMedia(
      malformedPlan,
      statePath,
      port,
      { origin: runtime.origin },
      { providers: ['bangumi'] },
      currentBindings,
    );
    expect(malformedRefresh.characterDiagnostics).toContainEqual(
      expect.objectContaining({ path: '/subject-characters/1/type', reason: 'invalid_source_value' }),
    );

    const correctedPlan = await planCrossMediaSeed(sourceTables(0));
    const corrected = await seedCrossMedia(
      correctedPlan,
      statePath,
      port,
      { origin: runtime.origin },
      { providers: ['bangumi'] },
      currentBindings,
    );
    expect(corrected.characterDiagnostics).toContainEqual(
      expect.objectContaining({ path: '/subject-characters/2/type', reason: 'missing_concept' }),
    );
    const publication = await publishShowcase({
      plan: correctedPlan,
      result: corrected,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
      vocabularyRequirements: activeRequirements(concepts.requirements, currentBindings),
    });

    const correctedIds = identityReads(corrected);
    expect(correctedIds).toEqual(acknowledged);
    expect(publication.status).toBe('incomplete');
    const gameId = acknowledged.get('103')!;
    const characterAId = acknowledged.get('character:902')!;
    const characterBId = acknowledged.get('character:903')!;
    const performerAId = acknowledged.get('person:1001')!;
    const performerBId = acknowledged.get('person:1002')!;
    const roleOne = currentBindings.concepts.find(
      (entry) => entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '1',
    )!;
    const game = subjectStatements(await publicClient.readSubject(gameId));
    const characterA = subjectStatements(await publicClient.readSubject(characterAId));
    const characterB = subjectStatements(await publicClient.readSubject(characterBId));
    const performerA = subjectStatements(await publicClient.readSubject(performerAId));
    const performerB = subjectStatements(await publicClient.readSubject(performerBId));
    expect(game.type).toBe('schema:VideoGame');
    expect(game.statements['wdt:P5732']?.[0]?.value.content).toBe('103');
    expect(characterA.type).toBe('wd:Q95074');
    expect(characterA.statements['wdt:P6296']?.[0]?.value.content).toBe('902');
    expect(characterB.statements['wdt:P6296']?.[0]?.value.content).toBe('903');
    expect(performerA.type).toBe('schema:Person');
    expect(performerA.statements['wdt:P6298']?.[0]?.value.content).toBe('1001');
    expect(performerB.statements['wdt:P6298']?.[0]?.value.content).toBe('1002');

    expect(game.statements['schema:character']).toHaveLength(1);
    const appearance = game.statements['schema:character']![0]!;
    expect(appearance.value.content).toBe(characterAId);
    expect(appearance.qualifiers).toContainEqual({
      property: { id: 'wdt:P3831' },
      value: { content: roleOne.id },
    });
    expect(JSON.stringify(appearance.references)).toContain('https://bgm.tv/subject/103#/subject-characters/1/type');

    const voices = game.statements['wdt:P725'] ?? [];
    expect(voices).toHaveLength(2);
    for (const [personId, characterId, creditedAs, path] of [
      [performerAId, characterAId, 'Voice A', '/person-characters/103/1001/902'],
      [performerBId, characterBId, 'Voice B', '/person-characters/103/1002/903'],
    ]) {
      const voice = voices.find((statement) => statement.value.content === personId);
      expect(voice?.qualifiers).toContainEqual({ property: { id: 'wdt:P453' }, value: { content: characterId } });
      expect(voice?.qualifiers).toContainEqual({ property: { id: 'wdt:P1932' }, value: { content: creditedAs } });
      expect(JSON.stringify(voice?.references)).toContain(`https://bgm.tv/subject/103#${path}`);
    }
    expect(voices.some((statement) => statement.value.content === acknowledged.get('person:1003'))).toBe(false);
    expect(characterA.statements['schema:keywords']?.length ?? 0).toBeGreaterThan(0);
    expect(characterB.statements['schema:keywords']?.length ?? 0).toBeGreaterThan(0);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
