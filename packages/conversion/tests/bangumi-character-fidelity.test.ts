import { expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import { mapBangumiVocabulary } from '../src/bangumi-vocabulary.ts';
import type { NativeIdentity, SourceVocabularyInput } from '../src/source-vocabulary.ts';

const characterKindScheme = '00000000-0000-8000-8000-000000000101';
const appearanceScheme = '00000000-0000-8000-8000-000000000102';
const kindConcept = '00000000-0000-8000-8000-000000000201';
const roleConcept = '00000000-0000-8000-8000-000000000202';
const character: NativeIdentity = {
  id: '00000000-0000-8000-8000-000000000301',
  type: 'wd:Q95074',
  releaseDigest: bundledDigest,
};
const work: NativeIdentity = {
  id: '00000000-0000-8000-8000-000000000302',
  type: 'schema:TVSeries',
  releaseDigest: bundledDigest,
};
const bindings = {
  releaseDigest: bundledDigest,
  schemes: [
    {
      taxonomy: 'bangumi.character.role',
      id: characterKindScheme,
      uri: 'https://rezics.com/schemes/bangumi/character-kinds',
      type: 'skos:ConceptScheme' as const,
      releaseDigest: bundledDigest,
    },
    {
      taxonomy: 'bangumi.subject-characters.type',
      id: appearanceScheme,
      uri: 'https://rezics.com/schemes/bangumi/appearance-roles',
      type: 'skos:ConceptScheme' as const,
      releaseDigest: bundledDigest,
    },
  ],
  concepts: [
    {
      taxonomy: 'bangumi.character.role',
      code: '1',
      id: kindConcept,
      type: 'skos:Concept' as const,
      schemeId: characterKindScheme,
      releaseDigest: bundledDigest,
    },
    {
      taxonomy: 'bangumi.subject-characters.type',
      code: '1',
      id: roleConcept,
      type: 'skos:Concept' as const,
      schemeId: appearanceScheme,
      releaseDigest: bundledDigest,
    },
  ],
};

function input(
  externalId: string,
  recordUrl: string,
  rows: SourceVocabularyInput['rows'],
  vocabularyBindings: SourceVocabularyInput['bindings'] = bindings,
): SourceVocabularyInput {
  return {
    metadata: {
      provider: 'bangumi',
      sourceAlias: 'bangumi_cross_media',
      externalId,
      recordRevision: '7',
      digest: 'a'.repeat(64),
      converterRevision: 'cross-media-entities@2',
      recordUrl,
      license: 'CC-BY-SA-3.0',
      attribution: 'Bangumi contributors',
    },
    bindings: vocabularyBindings,
    rows,
  };
}

function statement(command: BatchCommand): BatchStatement | undefined {
  return command.op === 'propose' ? command.statement : undefined;
}

test('Bangumi character kinds and appearance roles target exact Concepts; unsupported source order stays diagnostic', () => {
  const kind = mapBangumiVocabulary(
    input('character:990001', 'https://bgm.tv/character/990001', [
      { kind: 'character-kind', path: '/character/990001/type', character, code: 1 },
    ]),
  );
  expect(kind.gaps).toEqual([]);
  expect(kind.proposals).toHaveLength(1);
  expect(statement(kind.proposals[0]!)).toMatchObject({
    property: { id: 'schema:keywords' },
    value: { type: 'value', content: kindConcept },
    references: [
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://bgm.tv/character/990001#/character/990001/type' },
          }),
        ]),
      }),
    ],
  });

  const appearance = mapBangumiVocabulary(
    input('990010', 'https://bgm.tv/subject/990010', [
      {
        kind: 'character-appearance',
        path: '/subject-characters/2/type',
        subject: work,
        character,
        characterCode: '990001',
        roleCode: 1,
        order: 0,
      },
    ]),
  );
  const fact = statement(appearance.proposals[0]!);
  expect(fact).toMatchObject({
    property: { id: 'schema:character' },
    value: { type: 'value', content: character.id },
    qualifiers: [
      expect.objectContaining({
        property: { id: 'wdt:P3831' },
        value: { type: 'value', content: roleConcept },
      }),
    ],
    references: [
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://bgm.tv/subject/990010#/subject-characters/2/type' },
          }),
        ]),
      }),
    ],
  });
  expect(appearance.gaps).toContainEqual(
    expect.objectContaining({
      path: '/subject-characters/2/type',
      code: '1',
      reason: 'qualifier_not_admitted',
      property: 'schema:position',
    }),
  );
  expect(JSON.stringify(fact)).not.toContain('schema:position');

  const unknown = mapBangumiVocabulary(
    input('character:990001', 'https://bgm.tv/character/990001', [
      { kind: 'character-kind', path: '/character/990001/type', character, code: 99 },
    ]),
  );
  expect(unknown.proposals).toEqual([]);
  expect(unknown.gaps).toContainEqual(
    expect.objectContaining({ path: '/character/990001/type', code: '99', reason: 'unknown_code' }),
  );

  const missingRole = mapBangumiVocabulary(
    input(
      '990010',
      'https://bgm.tv/subject/990010',
      [
        {
          kind: 'character-appearance',
          path: '/subject-characters/2/type',
          subject: work,
          character,
          characterCode: 'character:990001',
          roleCode: 1,
        },
      ],
      { ...bindings, concepts: bindings.concepts.filter((item) => item.id !== roleConcept) },
    ),
  );
  expect(missingRole.proposals).toEqual([]);
  expect(missingRole.gaps).toContainEqual(
    expect.objectContaining({
      path: '/subject-characters/2/type',
      code: '1',
      reason: 'missing_concept',
      property: 'skos:Concept',
    }),
  );
});
