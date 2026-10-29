import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index.ts';
import { convertVndb, converter_revision } from '../src/vndb.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';

function input(latin: unknown = null, title = '港の物語') {
  const latinField = arguments.length > 0 && arguments[0] === undefined ? {} : { latin };
  return {
    external_id: 'v124',
    record_revision: '19',
    record: {
      vn: { id: 'v124', olang: 'ja' },
      entry_meta: { id: 'v124', revision: 19, lastmod: '2026-10-24' },
      vn_titles: [{ id: 'v124', lang: 'ja', official: true, title, ...latinField }],
    },
  };
}

function expectInvalid(value: ReturnType<typeof input>, pointer: string) {
  try {
    convertVndb(value);
    throw new Error('Expected VNDB conversion to reject the input');
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionError);
    expect((error as ConversionError).pointer).toBe(pointer);
  }
}

test('optional Latin preserves null, exact empty and nonempty values without inventing names', () => {
  const empty = convertVndb(input(''));
  expect(empty.normalizedRecord.vn_titles[0]?.latin).toBe('');
  expect(empty.proposals).toHaveLength(1);
  if (empty.proposals[0]?.op !== 'create') throw new Error('Expected bootstrap command');
  expect(empty.proposals[0].subject.labels).toEqual({ ja: '港の物語' });
  expect(empty.proposals[0].subject).not.toHaveProperty('aliases');
  expect(checkBatchWrite({ commands: empty.proposals })).toEqual([]);

  const resolved = convertVndb(input(''), { subjectId });
  expect(resolved.normalizedRecord.vn_titles[0]?.latin).toBe('');
  expect(resolved.proposals).toHaveLength(3);
  const resolvedNames = resolved.proposals.flatMap((command) => command.op === 'propose' ? [command.statement] : [])
    .filter((statement) => statement.property.id === 'schema:name')
    .map((statement) => statement.value.type === 'value' ? statement.value.content : null);
  expect(resolvedNames).toEqual([{ language: 'ja', text: '港の物語' }]);
  expect(checkBatchWrite({ commands: resolved.proposals })).toEqual([]);

  const absent = convertVndb(input(null));
  expect(absent.normalizedRecord.vn_titles[0]?.latin).toBeNull();
  expect(absent.proposals[0]).toMatchObject({ op: 'create', subject: { labels: { ja: '港の物語' } } });
  expect(absent.proposals[0]?.op === 'create' && absent.proposals[0].subject).not.toHaveProperty('aliases');
  expect(empty.digest).not.toBe(absent.digest);
  expect(empty.digest).toBe(resolved.digest);
  expect(convertVndb(input(''), { subjectId: '00000000-0000-4000-8000-000000000002' }).digest).toBe(empty.digest);
  expect(empty.digest).toBe(convertVndb(input(''), {}, { converterRevision: 'vndb@999-test' }).digest);
  expect(empty.record_revision).toBe('19');
  expect(empty.converter_revision).toBe(converter_revision);
  const nonempty = convertVndb(input('Minato no Monogatari'), { subjectId });
  expect(nonempty.normalizedRecord.vn_titles[0]?.latin).toBe('Minato no Monogatari');
  expect(nonempty.digest).not.toBe(empty.digest);
  expect(nonempty.proposals)
    .toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: 'propose',
        statement: expect.objectContaining({
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'ja-Latn', text: 'Minato no Monogatari' } },
        }),
      }),
    ]));
});

test('optional Latin and required primary title retain strict invalid controls and paths', () => {
  for (const invalid of [' ', '\t', '\n', '\r\n']) expectInvalid(input(invalid), '/vn_titles/0/latin');
  for (const invalid of [undefined, 7, false, {}]) expectInvalid(input(invalid), '/vn_titles/0/latin');
  for (const title of ['', '  ', null as unknown as string]) expectInvalid(input('', title), '/vn_titles/0/title');
});
