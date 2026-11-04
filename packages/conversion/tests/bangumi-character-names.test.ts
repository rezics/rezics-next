import { expect, test } from 'bun:test';
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
