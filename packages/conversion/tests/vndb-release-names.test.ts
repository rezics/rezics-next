import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index.ts';
import { converter_revision, convertCrossMediaEntity, vndbReleaseNameLimits } from '../src/cross-media-entities.ts';

const subjectId = '00000000-0000-4000-8000-000000000004';

function title(
  lang: string,
  name: string,
  latin: string | null = null,
  mtl = false,
  id = 'r1',
): Record<string, unknown> {
  return { id, lang, mtl, title: name, latin };
}

function record(titles: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    external_id: 'r1',
    record_revision: null,
    record: { id: 'r1', minage: 0, ...extra, releases_titles: titles },
  };
}

function expectInvalid(input: ReturnType<typeof record>, pointer: string) {
  try {
    convertCrossMediaEntity(input);
    throw new Error('Expected conversion to reject the input');
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionError);
    expect((error as ConversionError).pointer).toBe(pointer);
  }
}

function names(output: ReturnType<typeof convertCrossMediaEntity>, property: string) {
  return output.proposals.flatMap((command) =>
    command.op === 'propose' && command.statement.property.id === property && command.statement.value.type === 'value'
      ? [command.statement.value.content]
      : [],
  );
}

test('authored multilingual release titles keep language, latin and a stable label', () => {
  const titles = [
    title('en', 'Harbor Soft', null, true),
    title('ja', '港の題名', 'Minato no Daimei'),
    title('ja', '港別題'),
  ];
  const shuffled = convertCrossMediaEntity(record([...titles].reverse(), { released: '20200229' }));
  const authored = convertCrossMediaEntity(record(titles, { released: '20200229' }));
  expect(authored.converter_revision).toBe(converter_revision);
  expect(converter_revision).not.toBe('cross-media-entities@2');
  expect(authored.digest).toBe(shuffled.digest);
  expect(authored.normalizedRecord.releases_titles).toEqual(shuffled.normalizedRecord.releases_titles);
  const create = authored.proposals[0];
  if (create?.op !== 'create') throw new Error('Expected bootstrap');
  expect(create.subject.type).toBe('wd:Q20631656');
  expect(create.subject.labels).toEqual({ en: 'Harbor Soft', ja: '港の題名' });
  expect(create.subject.aliases).toEqual({ ja: ['港別題'], 'ja-Latn': ['Minato no Daimei'] });
  const bound = convertCrossMediaEntity(record(titles), { subjectId });
  expect(checkBatchWrite({ commands: bound.proposals.slice(0, 100) })).toEqual([]);
  expect(names(bound, 'schema:name')).toEqual([
    { language: 'en', text: 'Harbor Soft' },
    { language: 'ja', text: '港の題名' },
    { language: 'ja', text: '港別題' },
  ]);
  expect(names(bound, 'schema:alternateName')).toEqual([{ language: 'ja-Latn', text: 'Minato no Daimei' }]);
  expect(
    bound.proposals.some(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:inLanguage',
    ),
  ).toBe(false);
  expect(authored.diagnostics).toEqual([]);
});

test('legacy scalar release title stays an untagged name', () => {
  const output = convertCrossMediaEntity({
    external_id: 'r1',
    record_revision: null,
    record: { id: 'r1', title: 'Authored exact release' },
  });
  expect(output.proposals).toHaveLength(1);
  expect(output.normalizedRecord).toMatchObject({ id: 'r1', name: 'Authored exact release' });
  expect(output.normalizedRecord).not.toHaveProperty('olang');
  expect(output.normalizedRecord).not.toHaveProperty('gtin');
  if (output.proposals[0]?.op !== 'create') throw new Error('Expected bootstrap');
  expect(output.proposals[0].subject.labels).toEqual({ und: 'Authored exact release' });
});

test('nullable and unadmitted latin keep the primary title', () => {
  const absent = convertCrossMediaEntity(record([title('ja', '港')]));
  const empty = convertCrossMediaEntity(record([title('ja', '港', '')]));
  expect(absent.normalizedRecord.releases_titles).toEqual([
    { id: 'r1', lang: 'ja', mtl: false, title: '港', latin: null },
  ]);
  expect((empty.normalizedRecord.releases_titles as { latin: string | null }[])[0]?.latin).toBe('');
  expect(empty.digest).not.toBe(absent.digest);
  expect(empty.diagnostics).toEqual([{ pointer: '/releases_titles/0/latin', code: 'unadmitted_empty_latin' }]);
  if (absent.proposals[0]?.op !== 'create' || empty.proposals[0]?.op !== 'create')
    throw new Error('Expected bootstrap');
  expect(absent.proposals[0].subject.labels).toEqual({ ja: '港' });
  expect(empty.proposals[0].subject.labels).toEqual({ ja: '港' });
  expect(empty.proposals[0].subject).not.toHaveProperty('aliases');
  const blank = convertCrossMediaEntity(record([title('ja', '港', ' ')]));
  expect(blank.diagnostics).toEqual([{ pointer: '/releases_titles/0/latin', code: 'unadmitted_latin' }]);
  expect(
    names(convertCrossMediaEntity(record([title('ja', '港', ' ')]), { subjectId }), 'schema:alternateName'),
  ).toEqual([]);
});

test('a release language with a null title retains source absence without inventing a name', () => {
  const input = record([{ id: 'r1', lang: 'en', mtl: false, title: null, latin: null }, title('ja', 'Known title')]);
  const bootstrap = convertCrossMediaEntity(input);
  expect(bootstrap.normalizedRecord).toMatchObject({
    releases_titles: expect.arrayContaining([{ id: 'r1', lang: 'en', mtl: false, title: null, latin: null }]),
  });
  if (bootstrap.proposals[0]?.op !== 'create') throw new Error('Expected bootstrap');
  expect(bootstrap.proposals[0].subject.labels).toEqual({ ja: 'Known title' });
  expect(names(convertCrossMediaEntity(input, { subjectId }), 'schema:name')).toEqual([
    { language: 'ja', text: 'Known title' },
  ]);
});

test('invalid language, malformed rows and bound edges stay at addressable paths', () => {
  const skipped = convertCrossMediaEntity(record([title('!!!!', 'Bad'), title('en', 'Harbor')]));
  expect(skipped.diagnostics).toEqual([{ pointer: '/releases_titles/0/lang', code: 'unadmitted_language' }]);
  if (skipped.proposals[0]?.op !== 'create') throw new Error('Expected bootstrap');
  expect(skipped.proposals[0].subject.labels).toEqual({ en: 'Harbor' });
  expectInvalid(record([title('en', 'Harbor', null, false, 'r9')]), '/releases_titles/0/id');
  expectInvalid(record([title('en', 'Harbor'), title('en', 'Harbor')]), '/releases_titles/1');
  expectInvalid(
    record(Array.from({ length: vndbReleaseNameLimits.maxTitles + 1 }, (_, i) => title('en', `T${i}`))),
    '/releases_titles',
  );
  expectInvalid(record([{ id: 'r1', lang: 'en', mtl: 'yes', title: 'Harbor', latin: null }]), '/releases_titles/0/mtl');
  expectInvalid(record([title('en', '')]), '/releases_titles/0/title');
  expect(vndbReleaseNameLimits.maxCommands).toBe(164);
});
