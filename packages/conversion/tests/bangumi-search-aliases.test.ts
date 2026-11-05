import { expect, test } from 'bun:test';
import { convertBangumi } from '../src/bangumi.ts';
import { extractBangumiSubjectNames } from '../src/bangumi-subject-names.ts';

// Exact selected archive names: dump-2026-10-20.210332Z, subjects 10380, 51 and 84148.
const records = [
  {
    id: 10380,
    type: 2,
    name: 'STEINS;GATE',
    name_cn: '命运石之门',
    aliases: ['シュタゲ', '石头门', '斯坦因之门', 'シュタインズ・ゲート'],
  },
  { id: 51, type: 2, name: 'CLANNAD -クラナド-', name_cn: 'CLANNAD', aliases: ['クラナド', '小镇家族'] },
  { id: 84148, type: 1, name: 'STEINS;GATE', name_cn: '命运石之门', aliases: ['シュタインズ・ゲート'] },
];

test('retained archive alias lists reach cited proposals without assigning a guessed language', () => {
  for (const { aliases, ...source } of records) {
    const infobox = `{{Infobox animanga/${source.type === 1 ? 'Manga' : 'TVAnime'}\r\n|别名={\r\n${aliases.map((name) => `[${name}]`).join('\r\n')}\r\n}\r\n}}`;
    const converted = convertBangumi(
      { external_id: String(source.id), record_revision: 'archive', record: { ...source, infobox } },
      { subjectId: '00000000-0000-4000-8000-000000000001' },
    );
    for (const text of aliases)
      expect(converted.proposals).toContainEqual(
        expect.objectContaining({
          op: 'propose',
          statement: expect.objectContaining({
            property: { id: source.type === 1 ? 'schema:name' : 'schema:alternateName' },
            value: { type: 'value', content: { language: 'und', text } },
            references: expect.any(Array),
          }),
        }),
      );
    expect(converted.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'unsupported_infobox_name_form' }),
    );
  }
});

test('unfinished, nested and mixed archive lists omit that field, preserving the top-level name', () => {
  for (const list of ['{\n[シュタゲ]', '{\n[[シュタゲ]]\n}', '{\n[シュタゲ]\n}\nextra']) {
    const names = extractBangumiSubjectNames(
      { type: 2, name: 'STEINS;GATE', infobox: `{{Infobox animanga/TVAnime\n|别名=${list}\n}}` },
      'schema:TVSeries',
    );
    expect(names.names.map(({ text }) => text)).toEqual(['STEINS;GATE']);
    expect(names.diagnostics).toContainEqual({ pointer: '/infobox/fields/0', code: 'unsupported_infobox_name_form' });
  }
});
