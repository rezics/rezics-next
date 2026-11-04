import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { NativeIdentity, SourceVocabularyBindings, SourceVocabularyRow } from '@rezics/conversion';
import { mapBangumiVocabulary } from '@rezics/conversion/bangumi-vocabulary';
import { bangumiRecordUrl, converter_revision } from '@rezics/conversion/cross-media-entities';
import { crossMediaAliases, planCrossMediaSeed, type CrossMediaTables } from '../src/cross-media-seed.ts';
import { buildBangumiCreatorCreditRows } from '../src/bangumi-creator-credits.ts';
import { bangumiAppearanceSource } from '../src/cross-media-bindings.ts';

const id = (n: number, type: string): NativeIdentity => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  type,
  releaseDigest: bundledDigest,
});
const game = id(1, 'schema:VideoGame');
const role = id(2, 'skos:Concept');
const characterA = id(3, 'wd:Q95074');
const characterB = id(4, 'wd:Q95074');
const performerA = id(5, 'schema:Person');
const performerB = id(6, 'schema:Person');
const bindings: SourceVocabularyBindings = {
  releaseDigest: bundledDigest,
  schemes: [{
    taxonomy: 'bangumi.subject-characters.type',
    id: id(7, 'skos:ConceptScheme').id,
    uri: 'https://rezics.com/schemes/bangumi/appearance-roles',
    type: 'skos:ConceptScheme',
    releaseDigest: bundledDigest,
  }],
  concepts: [{
    taxonomy: 'bangumi.subject-characters.type',
    code: '1',
    id: role.id,
    type: 'skos:Concept',
    schemeId: id(7, 'skos:ConceptScheme').id,
    releaseDigest: bundledDigest,
  }],
};

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
  return { async *rows(provider, table) { yield* rows[`${provider}/${table}`] ?? []; } };
}

function metadata() {
  return {
    provider: 'bangumi' as const,
    sourceAlias: crossMediaAliases.bangumi,
    externalId: '103',
    recordRevision: null,
    digest: 'a'.repeat(64),
    converterRevision: converter_revision,
    recordUrl: bangumiRecordUrl('103'),
    license: 'CC-BY-SA-3.0',
    attribution: 'Bangumi contributors',
  };
}

test('selected Game rows keep role and exact Character-qualified performer evidence', async () => {
  const plan = await planCrossMediaSeed(sourceTables('unknown'));
  expect(plan.characterAppearances?.map(({ subjectId, characterId }) => [subjectId, characterId])).toEqual([['101', 901]]);
  expect(plan.gameCharacterAppearances?.map(({ subjectId, characterId }) => [subjectId, characterId])).toEqual([
    ['103', 902], ['103', 903],
  ]);
  const drafts = plan.credits.filter((draft) => draft.kind === 'voice-credit');
  expect(drafts.map(({ work, person, character }) => [work, person, character])).toEqual([
    ['103', 'person:1001', 'character:902'], ['103', 'person:1002', 'character:903'],
  ]);

  const appearance = plan.gameCharacterAppearances![0]!;
  const origin = bangumiAppearanceSource(crossMediaAliases.bangumi, appearance);
  const appearanceRow: SourceVocabularyRow = {
    kind: 'character-appearance',
    path: `/subject-characters/${appearance.sourceIndex}/type`,
    origin: {
      externalId: origin.external_id,
      revision: origin.record_revision,
      digest: origin.digest,
      url: bangumiRecordUrl('103'),
      converterRevision: origin.converter_revision,
    },
    subject: game,
    character: characterA,
    characterCode: 'character:902',
    roleCode: 1,
    order: -1,
  };
  const appearanceResult = mapBangumiVocabulary({ metadata: metadata(), bindings, rows: [appearanceRow] });
  const appearanceCommand = appearanceResult.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:character',
  );
  if (!appearanceCommand || appearanceCommand.op !== 'propose') throw new Error('Missing Game appearance proposal');
  expect(appearanceCommand).toMatchObject({
    subject: game.id,
    statement: {
      property: { id: 'schema:character' },
      value: { content: characterA.id },
      qualifiers: [{ property: { id: 'wdt:P3831' }, value: { content: role.id } }],
    },
  });
  expect(JSON.stringify(appearanceCommand.statement.references)).toContain(
    'https://bgm.tv/subject/103#/subject-characters/1/type',
  );
  expect(appearanceResult.gaps).toContainEqual(
    expect.objectContaining({ reason: 'invalid_source_value', property: 'schema:position' }),
  );

  const rows = buildBangumiCreatorCreditRows({
    drafts,
    identities: {
      '103': game,
      'person:1001': performerA,
      'person:1002': performerB,
      'character:902': characterA,
      'character:903': characterB,
    },
  });
  expect(rows.gaps).toEqual([]);
  const credits = mapBangumiVocabulary({ metadata: metadata(), bindings, rows: rows.rows });
  const voice = credits.proposals.find((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P725');
  if (!voice || voice.op !== 'propose') throw new Error('Missing Game voice-credit proposal');
  expect(credits.proposals).toHaveLength(2);
  expect(voice).toMatchObject({
    subject: game.id,
    statement: {
      value: { content: performerA.id },
      qualifiers: [
        { property: { id: 'wdt:P453' }, value: { content: characterA.id } },
        { property: { id: 'wdt:P1932' }, value: { content: 'Voice A' } },
      ],
    },
  });
  expect(JSON.stringify(voice?.statement.references)).toContain('https://bgm.tv/subject/103#/person-characters/103/1001/902');
});
