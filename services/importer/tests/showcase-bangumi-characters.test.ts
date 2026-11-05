import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import type { NativeIdentity, SourceVocabularyRow } from '@rezics/conversion';
import { bangumiRecordUrl, converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  type CrossMediaPlan,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { bangumiAppearanceSource } from '../src/cross-media-bindings.ts';
import { prepareShowcaseBangumiCharacterVocabulary } from '../src/showcase-bangumi-characters.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import type { ReviewedSubjectRead } from '../src/import-client.ts';

const characterKindsUri = 'https://rezics.com/schemes/bangumi/character-kinds';
const appearanceRolesUri = 'https://rezics.com/schemes/bangumi/appearance-roles';
const characterKindsSourceId = 'vocabulary:bangumi.character.role';
const appearanceRoleTwoSourceId = 'vocabulary:bangumi.subject-characters.type:2';

function tables(): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      { id: 101, name: 'STEINS;GATE', type: 2 },
      { id: 102, name: 'STEINS;GATE 0', type: 2 },
      { id: 103, name: 'STEINS;GATE Game', type: 4 },
      { id: 104, name: 'CLANNAD', type: 2 },
      { id: 105, name: 'Fate/stay night', type: 2 },
      { id: 201, name: 'Unrelated anime', type: 2 },
    ],
    'bangumi/subject-characters': [
      { subject_id: 101, character_id: 901, type: 1, order: 0 },
      { subject_id: 102, character_id: 901, type: 2, order: 4 },
      { subject_id: 103, character_id: 902, type: 1 },
      { subject_id: 201, character_id: 903, type: 1 },
    ],
    // Synthetic API-shaped row for selected-path forwarding; the source fixture lives under specs/fixtures/imports.
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

function vocabularyPort(journal: ShowcaseJournal) {
  const identities = new Map<string, string>();
  const subjects = new Map<string, { subject: { id: string; type: string; statements: Record<string, unknown[]> } }>();
  const charSchemeId = () => identities.get(characterKindsSourceId);
  return {
    async batch(request: { commands: BatchCommand[] }): Promise<BatchWriteResult> {
      for (const command of request.commands) journal.prepareCommand(command);
      const results = request.commands.map((command) => {
        let value: { id: string; revision: number } | { candidate: string; revision: number };
        if (command.op === 'create') {
          const id = randomUUID();
          identities.set(command.source.external_id, id);
          subjects.set(id, { subject: { id, type: command.subject.type, statements: {} } });
          value = { id, revision: 1 };
        } else {
          const subject = subjects.get(command.subject)?.subject;
          if (subject && command.op === 'propose') {
            const statement = structuredClone(command.statement) as { value: { type: string; content: unknown } };
            if (
              command.statement.property.id === 'skos:inScheme' &&
              command.source.external_id === appearanceRoleTwoSourceId
            )
              statement.value.content = charSchemeId();
            subject.statements[command.statement.property.id] = [statement];
          }
          value = { candidate: randomUUID(), revision: 1 };
        }
        return { key: command.key, status: 201 as const, value };
      });
      for (const [index, command] of request.commands.entries()) {
        journal.acknowledgeCommand(
          command,
          results[index]! as Extract<BatchWriteResult['results'][number], { status: 200 | 201 }>,
        );
      }
      return { results } as BatchWriteResult;
    },
    async readReviewedSubject(id: string) {
      const found = subjects.get(id);
      if (found) return found as ReviewedSubjectRead;
      throw Object.assign(new Error('Not found'), { status: 404 });
    },
  };
}

function identity(id: string, type: string): NativeIdentity {
  return { id, type, releaseDigest: bundledDigest };
}

function appearanceRow(
  plan: CrossMediaPlan,
  sourceIndex: number,
  work: NativeIdentity,
  character: NativeIdentity,
): SourceVocabularyRow {
  const appearance = plan.characterAppearances!.find((row) => row.sourceIndex === sourceIndex)!;
  const source = bangumiAppearanceSource(crossMediaAliases.bangumi, appearance);
  return {
    kind: 'character-appearance',
    path: `/subject-characters/${sourceIndex}/type`,
    origin: {
      externalId: source.external_id,
      revision: source.record_revision,
      digest: source.digest,
      url: bangumiRecordUrl(appearance.subjectId),
      converterRevision: source.converter_revision,
    },
    subject: work,
    character,
    characterCode: `character:${appearance.characterId}`,
    roleCode: appearance.roleCode as number,
    ...(appearance.order === undefined ? {} : { order: appearance.order as number }),
  };
}

test('default local adapter keeps character kinds separate from each anime appearance role and withholds a wrong-scheme role', async () => {
  const plan = await planCrossMediaSeed(tables());
  expect(
    plan.characterAppearances?.map(({ subjectId, characterId, roleCode }) => [subjectId, characterId, roleCode]),
  ).toEqual([
    ['101', 901, 1],
    ['102', 901, 2],
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-characters-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const port = vocabularyPort(journal);
    await prepareShowcaseBangumiCharacterVocabulary({ plan, port, journal, stage: 'schemes' });
    const prepared = await prepareShowcaseBangumiCharacterVocabulary({ plan, port, journal, stage: 'concepts' });
    const kind = prepared.bindings.concepts.find((entry) => entry.taxonomy === 'bangumi.character.role');
    const main = prepared.bindings.concepts.find(
      (entry) => entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '1',
    );
    const supporting = prepared.bindings.concepts.find(
      (entry) => entry.taxonomy === 'bangumi.subject-characters.type' && entry.code === '2',
    );
    expect(kind).toBeDefined();
    expect(main).toBeDefined();
    expect(supporting).toBeUndefined();

    const characterId = randomUUID();
    const character = identity(characterId, 'wd:Q95074');
    const registration = createSourceRegistration('bangumi', {
      source: crossMediaAliases.bangumi,
      converterRevision: entityRevision,
    });
    const characterRecord = plan.entities.bangumi.find((record) => record.key === 'character:901')!;
    const kindResult = registration.convert(
      { external_id: characterRecord.key, record_revision: null, record: characterRecord.payload },
      {
        source: crossMediaAliases.bangumi,
        subjectId: characterId,
        sourceVocabulary: {
          bindings: prepared.bindings,
          rows: [{ kind: 'character-kind', path: '/character/901/type', character, code: 1 }],
        },
      },
    );
    const selectedNames = kindResult.proposals.flatMap((command) =>
      command.op === 'propose' &&
      ['schema:name', 'schema:alternateName'].includes(command.statement.property.id)
        ? [command.statement.value]
        : [],
    );
    expect(selectedNames).toEqual([
      { type: 'value', content: { language: 'und', text: 'Okabe Rintaro' } },
      { type: 'value', content: { language: 'zh-Hans', text: '冈部伦太郎' } },
      { type: 'value', content: { language: 'en', text: 'Hououin Kyouma' } },
    ]);
    expect(kindResult.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['unlabelled_alias', 'unsupported_alias_label']),
    );
    expect(
      kindResult.proposals.find(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:keywords',
      ),
    ).toMatchObject({ statement: { value: { content: kind?.id } } });

    const workOneId = randomUUID();
    const workTwoId = randomUUID();
    const workOne = identity(workOneId, 'schema:TVSeries');
    const workTwo = identity(workTwoId, 'schema:TVSeries');
    const workOneRecord = plan.records.bangumi.find((record) => record.key === '101')!;
    const workTwoRecord = plan.records.bangumi.find((record) => record.key === '102')!;
    const workOneResult = registration.convert(
      { external_id: workOneRecord.key, record_revision: null, record: workOneRecord.payload },
      {
        source: crossMediaAliases.bangumi,
        subjectId: workOneId,
        sourceVocabulary: { bindings: prepared.bindings, rows: [appearanceRow(plan, 0, workOne, character)] },
      },
    );
    const workTwoResult = registration.convert(
      { external_id: workTwoRecord.key, record_revision: null, record: workTwoRecord.payload },
      {
        source: crossMediaAliases.bangumi,
        subjectId: workTwoId,
        sourceVocabulary: { bindings: prepared.bindings, rows: [appearanceRow(plan, 1, workTwo, character)] },
      },
    );
    const mainAppearance = workOneResult.proposals.find(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:character',
    );
    expect(mainAppearance).toMatchObject({
      subject: workOneId,
      statement: {
        value: { content: characterId },
        qualifiers: [{ property: { id: 'wdt:P3831' }, value: { content: main?.id } }],
      },
    });
    expect(mainAppearance?.source).toEqual(
      bangumiAppearanceSource(crossMediaAliases.bangumi, plan.characterAppearances![0]!),
    );
    expect(workTwoResult.sourceVocabularyGaps?.find((gap) => gap.reason === 'missing_concept')).toMatchObject({
      path: '/subject-characters/1/type',
      code: '2',
      property: 'skos:Concept',
    });
    expect(
      workTwoResult.proposals.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:character',
      ),
    ).toBe(false);
    expect(prepared.requirements.some((entry) => entry.sourceUri === `${characterKindsUri}/1`)).toBe(true);
    expect(prepared.requirements.some((entry) => entry.sourceUri === `${appearanceRolesUri}/1`)).toBe(true);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
