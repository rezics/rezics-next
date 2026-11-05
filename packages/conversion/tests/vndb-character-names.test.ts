import { expect, test } from 'bun:test';
import { ConversionError } from '../src/index.ts';
import { convertCrossMediaEntity } from '../src/cross-media-entities.ts';

const subjectId = '00000000-0000-4000-8000-000000000004';
const otherSubjectId = '00000000-0000-4000-8000-000000000005';

test('every admitted alias spoiler level uses the released dimensionless quantity value', () => {
  for (const level of [0, 1, 2]) {
    const output = convertCrossMediaEntity(
      record(
        'c1',
        [{ id: 'c1', lang: 'ja', name: 'Name', latin: null }],
        [{ id: 'c1', spoil: String(level), name: 'Alias', latin: null }],
      ),
      { subjectId },
    );
    expect(facts(output, 'schema:alternateName').at(-1)?.qualifiers).toEqual([
      {
        property: { id: 'rezics:spoilerLevel' },
        value: { type: 'value', content: { amount: `+${level}`, unit: '1' } },
      },
    ]);
  }
});

function record(id: string, names: Record<string, unknown>[], aliases: Record<string, unknown>[]) {
  return {
    external_id: id,
    record_revision: null,
    record: { id, chars_names: names, chars_alias: aliases },
  };
}

function facts(
  output: ReturnType<typeof convertCrossMediaEntity>,
  property: string,
): { value: { type: 'value'; content: unknown }; qualifiers?: { property: { id: string }; value: unknown }[] }[] {
  return output.proposals.flatMap((command) =>
    command.op === 'propose' && command.statement.property.id === property && command.statement.value.type === 'value'
      ? [
          {
            value: command.statement.value,
            ...(command.statement.qualifiers ? { qualifiers: command.statement.qualifiers } : {}),
          },
        ]
      : [],
  );
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

test('VNDB character names retain language and romanization while aliases remain qualified', () => {
  const names = [
    { id: 'c1', lang: 'ja', name: '美咲', latin: 'Misaki' },
    { id: 'c1', lang: 'zh-Hant', name: '美咲', latin: '' },
  ];
  const aliases = [{ id: 'c1', spoil: '2', name: 'Other Name', latin: 'Alias Romanized' }];
  const authored = convertCrossMediaEntity(record('c1', names, aliases));
  const shuffled = convertCrossMediaEntity(record('c1', [...names].reverse(), [...aliases].reverse()));
  const duplicated = convertCrossMediaEntity(record('c1', [...names, ...names], [...aliases, ...aliases]));
  expect(authored.digest).toBe(shuffled.digest);
  expect(authored.digest).toBe(duplicated.digest);
  expect(authored.normalizedRecord).toEqual(shuffled.normalizedRecord);
  expect(authored.proposals.map((command) => command.key)).toEqual(shuffled.proposals.map((command) => command.key));
  expect(authored.normalizedRecord.chars_names).toEqual(names);
  const create = authored.proposals[0];
  if (create?.op !== 'create') throw new Error('Expected bootstrap');
  expect(create.subject.labels).toEqual({ ja: '美咲', 'ja-Latn': 'Misaki', 'zh-Hant': '美咲' });
  expect(JSON.stringify(create.subject)).not.toContain('Other Name');

  const bound = convertCrossMediaEntity(record('c1', names, aliases), { subjectId });
  expect(facts(bound, 'schema:name').map((statement) => statement.value.content)).toEqual([
    { language: 'ja', text: '美咲' },
    { language: 'zh-Hant', text: '美咲' },
  ]);
  expect(facts(bound, 'schema:alternateName').map((statement) => statement.value.content)).toEqual([
    { language: 'ja-Latn', text: 'Misaki' },
    { language: 'und', text: 'Other Name' },
    { language: 'und-Latn', text: 'Alias Romanized' },
  ]);
  expect(
    facts(bound, 'schema:alternateName')
      .slice(1)
      .map((statement) => statement.qualifiers),
  ).toEqual([
    [{ property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+2', unit: '1' } } }],
    [{ property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+2', unit: '1' } } }],
  ]);
  expect(facts(bound, 'schema:alternateName')[0]?.qualifiers).toBeUndefined();
  expect(bound.diagnostics).toEqual([]);

  const nullLatin = convertCrossMediaEntity(record('c1', [names[0]!, { ...names[1]!, latin: null }], aliases), {
    subjectId,
  });
  expect(nullLatin.digest).not.toBe(bound.digest);
  expect(facts(nullLatin, 'schema:alternateName').map((statement) => statement.value.content)).toEqual(
    facts(bound, 'schema:alternateName').map((statement) => statement.value.content),
  );
});

test('changed names and spoiler levels change identity-bound proposal keys; matching spelling stays owner-local', () => {
  const names = [{ id: 'c1', lang: 'ja', name: '美咲', latin: 'Misaki' }];
  const aliases = [{ id: 'c1', spoil: '1', name: 'Shared alias', latin: null }];
  const original = convertCrossMediaEntity(record('c1', names, aliases), { subjectId });
  const changedName = convertCrossMediaEntity(record('c1', [{ ...names[0]!, name: '美咲・改' }], aliases), {
    subjectId,
  });
  const changedSpoiler = convertCrossMediaEntity(record('c1', names, [{ ...aliases[0]!, spoil: '2' }]), { subjectId });
  const otherOwner = convertCrossMediaEntity(
    record(
      'c2',
      [{ id: 'c2', lang: 'ja', name: '美咲', latin: null }],
      [{ id: 'c2', spoil: '2', name: 'Shared alias', latin: null }],
    ),
    { subjectId: otherSubjectId },
  );
  expect(changedName.digest).not.toBe(original.digest);
  expect(changedSpoiler.digest).not.toBe(original.digest);
  expect(changedName.proposals[1]?.key).not.toBe(original.proposals[1]?.key);
  expect(changedSpoiler.proposals.at(-1)?.key).not.toBe(original.proposals.at(-1)?.key);
  expect(otherOwner.proposals[0]?.key).not.toBe(original.proposals[0]?.key);
  expect(otherOwner.proposals.some((command) => command.op === 'propose' && command.subject === otherSubjectId)).toBe(
    true,
  );
  expect(facts(otherOwner, 'schema:alternateName').at(-1)?.qualifiers).toEqual([
    { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '+2', unit: '1' } } },
  ]);
});

test('unrepresentable spoiler levels withhold the complete alias without leaking bootstrap terms', () => {
  const input = record(
    'c1',
    [{ id: 'c1', lang: 'ja', name: '美咲', latin: 'Misaki' }],
    [{ id: 'c1', spoil: '3', name: 'Hidden alias', latin: 'Hidden Latin' }],
  );
  const bootstrap = convertCrossMediaEntity(input);
  const create = bootstrap.proposals[0];
  if (create?.op !== 'create') throw new Error('Expected bootstrap');
  expect(create.subject.labels).toEqual({ ja: '美咲', 'ja-Latn': 'Misaki' });
  expect(create.subject.aliases).toBeUndefined();
  expect(JSON.stringify(create.subject)).not.toContain('Hidden');
  expect(bootstrap.diagnostics).toEqual([{ pointer: '/chars_alias/0/spoil', code: 'unrepresentable_qualifier' }]);
  expect(facts(convertCrossMediaEntity(input, { subjectId }), 'schema:alternateName')).toEqual([
    expect.objectContaining({ value: { type: 'value', content: { language: 'ja-Latn', text: 'Misaki' } } }),
  ]);
});

test('malformed owner, language and oversized alias rows keep exact source diagnostics', () => {
  expectInvalid(record('c1', [{ id: 'c2', lang: 'ja', name: 'Wrong owner', latin: null }], []), '/chars_names/0/id');
  expectInvalid(
    record('c1', [{ id: 'c1', lang: 'not a language', name: 'Bad language', latin: null }], []),
    '/chars_names/0/lang',
  );
  const aliases = Array.from({ length: 65 }, (_, index) => ({
    id: 'c1',
    spoil: '0',
    name: `Alias ${index}`,
    latin: null,
  }));
  expectInvalid(record('c1', [], aliases), '/chars_alias');
});
