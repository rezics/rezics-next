import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import { convertCrossMediaEntity } from '../src/cross-media-entities.ts';

const characterId = '00000000-0000-4000-8000-000000000093';
const sourceAliases = [
  '[第二中文名|]',
  '[英文名|Chris Makise]',
  '[日文名|牧瀬 紅莉栖]',
  '[纯假名|まきせ くりす]',
  '[罗马字|Makise Kurisu]',
  '[昵称|天才少女，THE ZOMBIE/复苏者，克里斯蒂娜，天才，天才变态少女，放荡天才变态少女，助手，变态，セレブ・セブンティーン/Celeb Seventeen/土豪十七，セレセブ/Celeb Sev/土七，最爱实验妹， 蒙古斑少女，@Channeler，Dr.Pepperian，克里斯蒂娜博士]',
  '[重要绰号|克里斯蒂娜/クリスティーナ/Christina]',
  '[网名|栗悟饭和龟波功（栗悟飯と亀波功）（网名）]',
];
const infobox = (aliases: readonly string[]) =>
  ['{{Infobox Crt', '|简体中文名= 牧濑红莉栖', '|别名={', ...aliases, '}', '|性别= 女', '}}'].join('\r\n');
const officialCharacter = JSON.parse(
  readFileSync(new URL('../../../specs/fixtures/imports/bangumi/character-api-names.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const api = (record: Record<string, unknown> = officialCharacter) =>
  convertCrossMediaEntity(
    { external_id: 'character:1', record_revision: null, record },
    {
      source: 'bangumi_cross_media',
      subjectId: characterId,
    },
  );
const values = (output: ReturnType<typeof convert>, property: string) =>
  facts(output, property).map(({ value }) => value);
const fresh = () => structuredClone(officialCharacter);
const fields = (record: Record<string, unknown>) => record.infobox as { key: string; value: unknown }[];

function convert(aliases = sourceAliases, bound = true) {
  return convertCrossMediaEntity(
    {
      external_id: 'character:12393',
      record_revision: 'pinned-format-1',
      record: {
        id: 12393,
        name: '牧瀬紅莉栖',
        name_cn: null,
        type: null,
        summary: 'A source summary.',
        infobox: infobox(aliases),
      },
    },
    { source: 'bangumi_cross_media', ...(bound ? { subjectId: characterId } : {}) },
  );
}

function facts(output: ReturnType<typeof convert>, property: string) {
  return output.proposals.flatMap((command) =>
    command.op === 'propose' && command.statement.property.id === property && command.statement.value.type === 'value'
      ? [{ value: command.statement.value.content, source: command.source }]
      : [],
  );
}

test('serialized character projections replay the same source digest and complete name and measurement proposals', () => {
  const source = {
    id: 12393,
    name: '牧瀬紅莉栖',
    infobox: infobox(sourceAliases).replace('|性别= 女', '|性别= 女\r\n|身高=160cm'),
  };
  const input = { external_id: 'character:12393', record_revision: 'pinned-format-1', record: source };
  const context = { source: 'bangumi_cross_media', subjectId: characterId };
  const original = convertCrossMediaEntity(input, context);
  const replay = convertCrossMediaEntity(
    { ...input, record: JSON.parse(JSON.stringify(original.normalizedRecord)) },
    context,
  );
  expect(replay.digest).toBe(original.digest);
  expect(replay.normalizedRecord).toEqual(original.normalizedRecord);
  expect(replay.proposals).toEqual(original.proposals);
});

test('pinned Crt source names and aliases retain exact spelling and explicit label language', () => {
  const output = convert();
  const bootstrap = convert(sourceAliases, false);
  expect(output.normalizedRecord).toMatchObject({
    id: 12393,
    name: '牧瀬紅莉栖',
    type: null,
    summary: 'A source summary.',
    infobox_source: { kind: 'string', bytes: expect.any(Number), sha256: expect.any(String) },
  });
  expect(facts(output, 'schema:name').map(({ value }) => value)).toEqual([
    { language: 'und', text: '牧瀬紅莉栖' },
    { language: 'zh-Hans', text: '牧濑红莉栖' },
  ]);
  expect(facts(output, 'schema:alternateName').map(({ value }) => value)).toEqual([
    { language: 'en', text: 'Chris Makise' },
    { language: 'ja', text: '牧瀬 紅莉栖' },
    { language: 'ja', text: 'まきせ くりす' },
    { language: 'und-Latn', text: 'Makise Kurisu' },
    { language: 'und', text: '天才少女' },
    { language: 'und', text: 'THE ZOMBIE/复苏者' },
    { language: 'und', text: '克里斯蒂娜' },
    { language: 'und', text: '天才' },
    { language: 'und', text: '天才变态少女' },
    { language: 'und', text: '放荡天才变态少女' },
    { language: 'und', text: '助手' },
    { language: 'und', text: '变态' },
    { language: 'und', text: 'セレブ・セブンティーン/Celeb Seventeen/土豪十七' },
    { language: 'und', text: 'セレセブ/Celeb Sev/土七' },
    { language: 'und', text: '最爱实验妹' },
    { language: 'und', text: '蒙古斑少女' },
    { language: 'und', text: '@Channeler' },
    { language: 'und', text: 'Dr.Pepperian' },
    { language: 'und', text: '克里斯蒂娜博士' },
  ]);
  const create = bootstrap.proposals.find((command) => command.op === 'create');
  expect(create?.op === 'create' ? create.subject : undefined).toMatchObject({
    type: 'wd:Q95074',
    labels: { und: '牧瀬紅莉栖', 'zh-Hans': '牧濑红莉栖' },
  });
  expect(output.proposals[0]?.source).toMatchObject({
    source: 'bangumi_cross_media',
    external_id: 'character:12393',
  });
  expect(output.diagnostics).toContainEqual({ pointer: '/infobox/别名/6', code: 'unsupported_alias_label' });
  expect(output.diagnostics).toContainEqual({ pointer: '/infobox/别名/7', code: 'unsupported_alias_label' });
  expect(output.diagnostics.length).toBeLessThanOrEqual(16);
});

test('malformed alias groups preserve usable names and summary, while a removed alias changes source state', () => {
  const malformed = convert([...sourceAliases, '[英文名|{{unsupported}}]']);
  expect(malformed.diagnostics).toContainEqual({ pointer: '/infobox/别名/8', code: 'malformed_alias' });
  expect(facts(malformed, 'schema:name').map(({ value }) => value)).toEqual([
    { language: 'und', text: '牧瀬紅莉栖' },
    { language: 'zh-Hans', text: '牧濑红莉栖' },
  ]);
  expect(facts(malformed, 'schema:alternateName')).toEqual([]);
  expect(malformed.normalizedRecord.summary).toBe('A source summary.');

  const original = convert();
  const removedAssistant = sourceAliases.map((row) => row.replace('，助手，', '，'));
  const changed = convert(removedAssistant);
  expect(changed.digest).not.toBe(original.digest);
  expect(changed.normalizedRecord.infobox_source).not.toEqual(original.normalizedRecord.infobox_source);
  expect(facts(changed, 'schema:alternateName').map(({ value }) => value)).not.toContainEqual({
    language: 'und',
    text: '助手',
  });
  expect(facts(changed, 'schema:name')[0]?.source).toMatchObject({ external_id: 'character:12393' });
});

test('official parsed CharacterDetail names use only exact labelled API aliases and released cited statements', () => {
  const output = api();
  expect(output.normalizedRecord).toMatchObject({
    id: 1,
    type: 1,
    infobox_source: { kind: 'parsed', sha256: expect.any(String) },
    api_name_evidence: {
      name: { status: 'admitted' },
      name_cn: { status: 'null' },
      type: { status: 'admitted', value: 1 },
    },
  });
  expect(values(output, 'schema:name')).toEqual([
    { language: 'und', text: 'ルルーシュ・ランペルージ' },
    { language: 'zh-Hans', text: '鲁路修·兰佩路基' },
  ]);
  expect(values(output, 'schema:alternateName')).toEqual([
    { language: 'en', text: 'Lelouch Lamperouge' },
    { language: 'zh', text: '鲁路修·冯·布里塔尼亚' },
    { language: 'ja', text: 'ルルーシュ・ヴィ・ブリタニア' },
  ]);
  expect(output.diagnostics.map(({ code }) => code)).toEqual(
    expect.arrayContaining(['unlabelled_alias', 'unsupported_alias_label']),
  );
  for (const command of output.proposals.filter(
    (item) => item.op === 'propose' && ['schema:name', 'schema:alternateName'].includes(item.statement.property.id),
  )) {
    if (command.op !== 'propose') continue;
    expect(checkStatementInput(command.statement, bundledRelease).violations).toEqual([]);
    expect(command.statement.references?.[0]?.parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://bgm.tv/character/1' },
    });
  }
});

// These controlled refresh and malformed records are synthetic derivatives of the official fixture.
test('parsed API conflicts, malformed rows, overflow and source refresh retain bounded independent facts', () => {
  const baseline = api();

  const sameChinese = fresh();
  sameChinese.name_cn = '鲁路修·兰佩路基';
  expect(values(api(sameChinese), 'schema:name')).toEqual([
    { language: 'und', text: 'ルルーシュ・ランペルージ' },
    { language: 'zh', text: '鲁路修·兰佩路基' },
  ]);

  const conflictingChinese = fresh();
  conflictingChinese.name_cn = 'A different Chinese name';
  const conflict = api(conflictingChinese);
  expect(values(conflict, 'schema:name')).toEqual([{ language: 'und', text: 'ルルーシュ・ランペルージ' }]);
  expect(conflict.diagnostics).toContainEqual({ pointer: '/infobox/简体中文名', code: 'conflicting_source_name' });
  expect(values(conflict, 'schema:alternateName')).toHaveLength(3);

  const malformed = fresh();
  const aliasField = fields(malformed).find((field) => field.key === '别名')!;
  (aliasField.value as unknown[]).push({ k: '英文名', v: { nested: 'never stringify' } });
  const malformedResult = api(malformed);
  expect(values(malformedResult, 'schema:name')).toHaveLength(2);
  expect(values(malformedResult, 'schema:alternateName')).toHaveLength(3);
  expect(malformedResult.diagnostics).toContainEqual({ pointer: '/infobox/1/value/9', code: 'malformed_alias_value' });

  const duplicateName = fresh();
  duplicateName.name_cn = '鲁路修·兰佩路基';
  fields(duplicateName).push({
    key: '简体中文名',
    value: 'A conflicting parsed Chinese name',
  });
  const duplicateResult = api(duplicateName);
  expect(values(duplicateResult, 'schema:name')).toEqual([{ language: 'und', text: 'ルルーシュ・ランペルージ' }]);
  expect(duplicateResult.diagnostics.map(({ code }) => code)).toEqual(
    expect.arrayContaining(['duplicate_source_name', 'ambiguous_source_name', 'conflicting_source_name']),
  );

  const overflow = fresh();
  const overflowFields = fields(overflow);
  overflowFields[1]!.value = Array.from({ length: 65 }, (_, index) => ({ k: '英文名', v: `Alias ${index}` }));
  const overflowResult = api(overflow);
  expect(values(overflowResult, 'schema:name')).toHaveLength(2);
  expect(values(overflowResult, 'schema:alternateName')).toEqual([]);
  expect(overflowResult.diagnostics).toContainEqual({ pointer: '/infobox/1/value', code: 'alias_row_limit' });

  const fieldOverflow = fresh();
  fields(fieldOverflow).push(
    ...Array.from({ length: 64 }, (_, index) => ({ key: `Unknown ${index}`, value: 'ignored' })),
  );
  const fieldOverflowResult = api(fieldOverflow);
  expect(values(fieldOverflowResult, 'schema:name')).toEqual([{ language: 'und', text: 'ルルーシュ・ランペルージ' }]);
  expect(values(fieldOverflowResult, 'schema:alternateName')).toEqual([]);
  expect(fieldOverflowResult.diagnostics).toContainEqual({ pointer: '/infobox', code: 'infobox_field_limit' });

  const byteOverflow = fresh();
  fields(byteOverflow)[0]!.value = 'x'.repeat(32_768);
  const byteOverflowResult = api(byteOverflow);
  expect(values(byteOverflowResult, 'schema:name')).toEqual([{ language: 'und', text: 'ルルーシュ・ランペルージ' }]);
  expect(values(byteOverflowResult, 'schema:alternateName')).toEqual([]);
  expect(byteOverflowResult.diagnostics).toContainEqual({ pointer: '/infobox', code: 'infobox_byte_limit' });
  expect(byteOverflowResult.normalizedRecord.infobox_source).toMatchObject({ kind: 'over-limit' });

  const wrongType = fresh();
  wrongType.type = 2;
  const typeMismatch = api(wrongType);
  expect(values(typeMismatch, 'schema:name')).toEqual([]);
  expect(values(typeMismatch, 'schema:alternateName')).toEqual([]);
  expect(typeMismatch.diagnostics).toContainEqual({ pointer: '/type', code: 'invalid_character_api_type' });

  const wrongIdentity = fresh();
  wrongIdentity.id = 2;
  expect(() => api(wrongIdentity)).toThrow();

  const changed = fresh();
  const changedAlias = (fields(changed)[1]!.value as { k?: string; v: string }[]).find(
    (alias) => alias.k === '英文名',
  )!;
  changedAlias.v = 'Lelouch Lamperouge Revised';
  expect(api(changed).digest).not.toBe(baseline.digest);
  const absentNameCn = { ...officialCharacter };
  delete absentNameCn.name_cn;
  expect(api(absentNameCn).digest).not.toBe(baseline.digest);
});
