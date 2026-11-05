import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import { bundledDigest } from '@rezics/definitions/bundled';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import type { NativeIdentity, SourceVocabularyBindings, SourceVocabularyRow } from '@rezics/conversion';
import { crossMediaAliases } from '../src/cross-media-seed.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bindings: SourceVocabularyBindings = {
  releaseDigest: bundledDigest,
  schemes: [
    {
      taxonomy: 'bangumi.character.role',
      id: uuid(1),
      uri: 'https://rezics.com/schemes/bangumi/character-kinds',
      type: 'skos:ConceptScheme',
      releaseDigest: bundledDigest,
    },
    {
      taxonomy: 'bangumi.subject-characters.type',
      id: uuid(2),
      uri: 'https://rezics.com/schemes/bangumi/appearance-roles',
      type: 'skos:ConceptScheme',
      releaseDigest: bundledDigest,
    },
  ],
  concepts: [
    {
      taxonomy: 'bangumi.character.role',
      code: '1',
      id: uuid(3),
      type: 'skos:Concept',
      schemeId: uuid(1),
      releaseDigest: bundledDigest,
    },
    {
      taxonomy: 'bangumi.subject-characters.type',
      code: '1',
      id: uuid(4),
      type: 'skos:Concept',
      schemeId: uuid(2),
      releaseDigest: bundledDigest,
    },
  ],
};

const character: NativeIdentity = { id: uuid(5), type: 'wd:Q95074', releaseDigest: bundledDigest };
const work: NativeIdentity = { id: uuid(6), type: 'schema:TVSeries', releaseDigest: bundledDigest };
const registration = createSourceRegistration('bangumi', {
  source: crossMediaAliases.bangumi,
  converterRevision: entityRevision,
});
const officialCharacter = JSON.parse(
  readFileSync(new URL('./fixtures/bangumi-character-api-names.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

test('ordinary selected Character registration converts captured CharacterDetail names with released citations', () => {
  const result = registration.convert(
    { external_id: 'character:1', record_revision: null, record: officialCharacter },
    { source: crossMediaAliases.bangumi, subjectId: character.id },
  );
  const nameStatements = result.proposals.filter((command) =>
    command.op === 'propose' && ['schema:name', 'schema:alternateName'].includes(command.statement.property.id));
  expect(nameStatements.map((command) => [command.statement.property.id, command.statement.value])).toEqual([
    ['schema:name', { type: 'value', content: { language: 'und', text: 'ルルーシュ・ランペルージ' } }],
    ['schema:name', { type: 'value', content: { language: 'zh-Hans', text: '鲁路修·兰佩路基' } }],
    ['schema:alternateName', { type: 'value', content: { language: 'en', text: 'Lelouch Lamperouge' } }],
    ['schema:alternateName', { type: 'value', content: { language: 'zh', text: '鲁路修·冯·布里塔尼亚' } }],
    ['schema:alternateName', { type: 'value', content: { language: 'ja', text: 'ルルーシュ・ヴィ・ブリタニア' } }],
  ]);
  expect(nameStatements.map(({ source }) => source.external_id)).toEqual(Array(5).fill('character:1'));
  for (const command of nameStatements) {
    expect(checkStatementInput(command.statement, bundledRelease).violations).toEqual([]);
    expect(command.statement.references?.[0]?.parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://bgm.tv/character/1' },
    });
  }
  expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(['unlabelled_alias', 'unsupported_alias_label']));
});

test('Bangumi character facts retain source identities, concepts, citation, and unsupported order diagnostics', () => {
  const characterResult = registration.convert(
    {
      external_id: 'character:990001',
      record_revision: null,
      record: { id: 990001, name: 'Ari', name_cn: '阿莉', type: 1, summary: 'An authored character summary.' },
    },
    {
      source: crossMediaAliases.bangumi,
      subjectId: character.id,
      sourceVocabulary: {
        bindings,
        rows: [{ kind: 'character-kind', path: '/character/990001/type', character, code: 1 }],
      },
    },
  );

  const kind = characterResult.proposals.find(
    (item) => item.op === 'propose' && item.statement.property.id === 'schema:keywords',
  );
  expect(kind).toMatchObject({
    op: 'propose',
    subject: character.id,
    statement: {
      value: { type: 'value', content: uuid(3) },
      references: [
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              value: { type: 'value', content: 'https://bgm.tv/character/990001#/character/990001/type' },
            }),
          ]),
        }),
      ],
    },
  });
  const summary = characterResult.proposals.find(
    (item) => item.op === 'propose' && item.statement.property.id === 'schema:abstract',
  );
  expect(summary).toMatchObject({
    source: { field_group: 'summary' },
    rights: { license: 'CC-BY-SA-3.0', obligations: ['cc:Attribution', 'cc:ShareAlike'] },
    statement: {
      references: [
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://bgm.tv/character/990001' },
            }),
          ]),
        }),
      ],
    },
  });

  const appearanceRow = {
    kind: 'character-appearance',
    path: '/subject-characters/2/type',
    subject: work,
    character,
    characterCode: 'character:990001',
    roleCode: 1,
    order: 2,
  } as unknown as SourceVocabularyRow;
  const workResult = registration.convert(
    {
      external_id: '990010',
      record_revision: null,
      record: { id: 990010, name: 'Authored Work', type: 2 },
    },
    {
      source: crossMediaAliases.bangumi,
      subjectId: work.id,
      sourceVocabulary: { bindings, rows: [appearanceRow] },
    },
  );
  const appearance = workResult.proposals.find(
    (item) => item.op === 'propose' && item.statement.property.id === 'schema:character',
  );
  expect(appearance).toMatchObject({
    op: 'propose',
    subject: work.id,
    statement: {
      value: { type: 'value', content: character.id },
      qualifiers: [{ property: { id: 'wdt:P3831' }, value: { type: 'value', content: uuid(4) } }],
      references: [
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              value: { type: 'value', content: 'https://bgm.tv/subject/990010#/subject-characters/2/type' },
            }),
          ]),
        }),
      ],
    },
  });
  expect(workResult.sourceVocabularyGaps).toContainEqual(
    expect.objectContaining({
      path: '/subject-characters/2/type',
      code: '1',
      reason: 'qualifier_not_admitted',
      property: 'schema:position',
    }),
  );
});
