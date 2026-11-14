import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import { bundledDigest } from '@rezics/definitions/bundled';
import { converter_revision as entityRevision, mapSourceEnumeration } from '@rezics/conversion/cross-media-entities';
import type { NativeIdentity, SourceRecord, SourceVocabularyBindings, SourceVocabularyRow } from '@rezics/conversion';
import { runBangumiCharacterFidelity } from '../src/bangumi-character-fidelity.ts';
import { ImportTransportError, type ReviewedSubjectRead } from '../src/import-client.ts';
import type { Importer } from '../src/importer.ts';
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
  const nameStatements = result.proposals.flatMap((command) =>
    command.op === 'propose' && ['schema:name', 'schema:alternateName'].includes(command.statement.property.id)
      ? [command]
      : [],
  );
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
  expect(result.diagnostics.map(({ code }) => code)).toEqual(
    expect.arrayContaining(['unlabelled_alias', 'unsupported_alias_label']),
  );
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

test('Character fidelity bounds the identity read burst before importing and preserves source order and native errors', async () => {
  const records: SourceRecord[] = Array.from({ length: 16 }, (_, i) => ({
    source: 'bangumi',
    key: `character:${i + 1}`,
    revision: null,
    payload: { type: 1 },
  }));
  const subjects = new Map(records.map(({ key }, i) => [key, uuid(i + 100)]));
  const requested: string[] = [];
  const imported: string[] = [];
  const importer = {
    session: {
      bindings: {
        claim: ({ external_id }: { external_id: string }) => ({ state: 'bound', subject: subjects.get(external_id) }),
      },
    },
    async runRecords(_registration: unknown, input: AsyncIterable<SourceRecord>) {
      for await (const record of input) imported.push(record.key);
      return { status: 'committed' };
    },
  } as unknown as Importer;
  let active = 0,
    peak = 0,
    failure: Error | undefined;
  const port = {
    async readReviewedSubject(id: string): Promise<ReviewedSubjectRead> {
      requested.push(id);
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      if (failure && id === uuid(100)) throw failure;
      return {
        subject: {
          id,
          type: 'wd:Q95074',
          statements: {
            'wdt:P6296': [{ rank: 'normal', value: { type: 'value', content: String(Number(id.slice(-12)) - 99) } }],
          },
        },
      } as unknown as ReviewedSubjectRead;
    },
  };
  const run = () =>
    runBangumiCharacterFidelity({
      importer,
      port,
      sourceAlias: crossMediaAliases.bangumi,
      records,
      appearances: records.map((_, i) => ({ subjectId: '1', characterId: i + 1, sourceIndex: i, roleCode: 1 })),
    });
  await run();
  expect(peak).toBe(4);
  expect(requested).toEqual([...subjects.values()]);
  expect(imported).toEqual(records.map(({ key }) => key));
  requested.length = imported.length = 0;
  failure = new ImportTransportError(
    503,
    'https://rezics.com/problems/overloaded',
    'overloaded',
    true,
    undefined,
    'SubjectGET503',
  );
  await expect(run()).rejects.toBe(failure);
  expect(requested).toEqual([...subjects.values()].slice(0, 4));
  expect(imported).toEqual([]);
});

test('Bangumi appearances require current endpoint and role evidence and recover on unchanged input', async () => {
  type NativeStatement = { rank: string; value: { type: 'value'; content: unknown } };
  const exact = (content: unknown, rank = 'normal'): NativeStatement => ({ rank, value: { type: 'value', content } });
  const records: SourceRecord[] = [
    { source: 'bangumi', key: '990010', revision: null, payload: { id: 990010, type: 2, name: 'Work' } },
    { source: 'bangumi', key: 'character:990011', revision: null, payload: { id: 990011, type: 1, name: 'One' } },
    { source: 'bangumi', key: 'character:990012', revision: null, payload: { id: 990012, type: 1, name: 'Two' } },
  ];
  const nativeIds = new Map(records.map((record, index) => [record.key, uuid(20 + index)]));
  const native = new Map<string, { id: string; type: string; statements: Record<string, NativeStatement[]> }>();
  const add = (id: string, type: string, statements: Record<string, NativeStatement[]>) =>
    native.set(id, { id, type, statements });
  const workId = nativeIds.get('990010')!;
  const firstCharacter = nativeIds.get('character:990011')!;
  const secondCharacter = nativeIds.get('character:990012')!;
  add(workId, 'schema:TVSeries', { 'wdt:P5732': [exact('990010')] });
  add(firstCharacter, 'wd:Q95074', { 'wdt:P6296': [exact('990011', 'deprecated')] });
  add(secondCharacter, 'wd:Q95074', { 'wdt:P6296': [exact('990012')] });
  add(uuid(2), 'skos:ConceptScheme', { 'schema:url': [exact(bindings.schemes[1]!.uri)] });
  add(uuid(4), 'skos:Concept', {
    'schema:url': [exact(mapSourceEnumeration('bangumi', 'subject-characters.type', '1')?.concept?.id ?? '')],
    'skos:inScheme': [exact(uuid(2))],
  });
  const roleBindings: SourceVocabularyBindings = {
    releaseDigest: bundledDigest,
    schemes: [bindings.schemes[1]!],
    concepts: [bindings.concepts[1]!],
  };
  const alter = (id: string, property: string, rank: string) => {
    native.get(id)!.statements[property]![0]!.rank = rank;
  };
  const restore = (id: string, property: string, content: unknown, rank = 'preferred') =>
    native.get(id)!.statements[property]!.push(exact(content, rank));
  const proposals: string[] = [];
  const importer = {
    session: {
      bindings: {
        claim: ({ external_id }: { external_id: string }) => ({ state: 'bound', subject: nativeIds.get(external_id)! }),
      },
    },
    async runRecords(source: unknown, input: AsyncIterable<SourceRecord>) {
      const registration = source as {
        convert(
          record: { external_id: string; record_revision: null; record: unknown },
          context: { source: string; subjectId: string },
        ): {
          proposals: {
            op: string;
            statement: { property: { id: string }; value: { content: unknown } };
          }[];
        };
      };
      for await (const record of input) {
        if (record.key !== '990010') continue;
        const converted = registration.convert(
          { external_id: record.key, record_revision: null, record: record.payload },
          { source: crossMediaAliases.bangumi, subjectId: workId },
        );
        for (const command of converted.proposals)
          if (command.op === 'propose' && command.statement.property.id === 'schema:character')
            proposals.push(command.statement.value.content as string);
      }
      return { status: 'committed' };
    },
  } as unknown as Importer;
  const port = {
    async readReviewedSubject(id: string) {
      return { subject: native.get(id) } as unknown as ReviewedSubjectRead;
    },
  };
  const refresh = async () => {
    proposals.length = 0;
    await runBangumiCharacterFidelity({
      importer,
      port,
      sourceAlias: crossMediaAliases.bangumi,
      records,
      appearances: [
        { subjectId: '990010', characterId: 990011, sourceIndex: 0, roleCode: 1 },
        { subjectId: '990010', characterId: 990012, sourceIndex: 1, roleCode: 1 },
      ],
      bindings: roleBindings,
    });
    return proposals.sort();
  };

  expect(await refresh()).toEqual([secondCharacter]);
  restore(firstCharacter, 'wdt:P6296', '990011');
  alter(uuid(2), 'schema:url', 'deprecated');
  alter(uuid(4), 'schema:url', 'deprecated');
  alter(uuid(4), 'skos:inScheme', 'deprecated');
  expect(await refresh()).toEqual([]);
  restore(uuid(2), 'schema:url', bindings.schemes[1]!.uri);
  restore(uuid(4), 'schema:url', mapSourceEnumeration('bangumi', 'subject-characters.type', '1')?.concept?.id ?? '');
  restore(uuid(4), 'skos:inScheme', uuid(2));
  expect(await refresh()).toEqual([firstCharacter, secondCharacter].sort());
});
