import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { derivedId, newId, routeOf } from '../../src/route/route.ts';
import {
  itemFacts as structuralItemFacts,
  resolveItem as resolve,
  SubjectInputError,
  type Fact,
  type FactRow,
  type Statement,
} from '../../src/semantic/item.ts';
import { checkTyped } from '../../src/semantic/rules.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { DataType } from '@rezics/definitions';

const dataTypes = Object.fromEntries(
  Object.entries(bundledRelease.properties).map(([id, property]) => [id, property.datatype]),
) as Record<string, DataType>;
const itemFacts = (id: string, input: unknown) => {
  const typedInput =
    typeof input === 'object' && input !== null ? { type: 'bf:Instance', ...(input as object) } : input;
  const type = String((typedInput as Record<string, unknown>).type);
  let facts: Fact[];
  let structural: SubjectInputError | undefined;
  try {
    facts = structuralItemFacts(id, typedInput, type);
  } catch (error) {
    if (!(error instanceof SubjectInputError)) throw error;
    structural = error;
    facts = [];
  }
  const checked = checkTyped(bundledRelease, bundledDigest, typedInput);
  if (structural || checked.violations.length)
    throw new SubjectInputError([...(structural?.violations ?? []), ...checked.violations]);
  return facts;
};
const resolveItem = (id: string, facts: readonly FactRow[]) =>
  resolve(id, facts, 'bf:Instance', dataTypes, { revision: 1, release: bundledDigest, context: GLOBAL_CONTEXT });

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLOTS = 'c30d6caa-d9e8-4108-a42a-35701219e8ec';
const STATEMENTS = '9f44e74c-b77c-47aa-96d0-b7a4aa330182';
const route = 0x2468;
const subjectId = newId(route);
const soseki = newId(0x1234);
const source = {
  property: { id: 'schema:url' },
  value: { type: 'value', content: 'https://www.aozora.gr.jp/cards/000148/card773.html' },
};
const book = {
  type: 'bf:Instance',
  labels: { en: 'Kokoro', ja: 'こゝろ' },
  descriptions: { en: 'novel by Natsume Sōseki' },
  aliases: { ja: ['心', 'こころ', 'こころ文庫'] },
  statements: {
    'schema:translator': [
      {
        property: { id: 'schema:translator' },
        value: { type: 'value', content: soseki },
        references: [{ parts: [source] }],
      },
      { property: { id: 'schema:translator' }, value: { type: 'somevalue' } },
    ],
    'schema:url': [
      {
        property: { id: 'schema:url' },
        value: { type: 'value', content: 'https://example.org/kokoro' },
        rank: 'preferred',
      },
    ],
    'schema:isbn': [
      {
        property: { id: 'schema:isbn' },
        value: { type: 'value', content: '978-4-10-101013-7' },
        references: [{ parts: [source] }],
      },
    ],
    'schema:numberOfPages': [
      {
        property: { id: 'schema:numberOfPages' },
        value: { type: 'value', content: { amount: '+384', unit: '1' } },
      },
    ],
  },
};
const slot = (kind: string, key: string) => derivedId(SLOTS, `${subjectId}\n${kind}\n${key}`, route);
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

test('a book becomes one fact row per value, in slots derived from the subject', () => {
  const facts = itemFacts(subjectId, book);
  expect(itemFacts(subjectId, book)).toEqual(facts);
  expect(facts).toHaveLength(11);
  expect(new Set(facts.map((fact) => fact.slot_id)).size).toBe(8);
  for (const fact of facts) {
    expect(fact.slot_id).toMatch(UUID_V8);
    expect(routeOf(fact.slot_id)).toBe(route);
    expect(fact.operation).toBe('assert');
  }
  const terms = facts.filter((fact) => fact.kind !== 'statement');
  expect(terms).toEqual([
    {
      slot_id: slot('label', 'en'),
      log_seq: 1,
      operation: 'assert',
      kind: 'label',
      language: 'en',
      property: null,
      statement_id: null,
      body: 'Kokoro',
    },
    {
      slot_id: slot('label', 'ja'),
      log_seq: 1,
      operation: 'assert',
      kind: 'label',
      language: 'ja',
      property: null,
      statement_id: null,
      body: 'こゝろ',
    },
    {
      slot_id: slot('description', 'en'),
      log_seq: 1,
      operation: 'assert',
      kind: 'description',
      language: 'en',
      property: null,
      statement_id: null,
      body: 'novel by Natsume Sōseki',
    },
    {
      slot_id: slot('alias', 'ja'),
      log_seq: 1,
      operation: 'assert',
      kind: 'alias',
      language: 'ja',
      property: null,
      statement_id: null,
      body: '心',
    },
    {
      slot_id: slot('alias', 'ja'),
      log_seq: 2,
      operation: 'assert',
      kind: 'alias',
      language: 'ja',
      property: null,
      statement_id: null,
      body: 'こころ',
    },
    {
      slot_id: slot('alias', 'ja'),
      log_seq: 3,
      operation: 'assert',
      kind: 'alias',
      language: 'ja',
      property: null,
      statement_id: null,
      body: 'こころ文庫',
    },
  ]);
  const urls = facts.filter((fact) => fact.property === 'schema:url');
  expect(urls).toEqual([
    {
      slot_id: slot('statement', 'schema:url'),
      log_seq: 1,
      operation: 'assert',
      kind: 'statement',
      language: null,
      property: 'schema:url',
      statement_id: derivedId(STATEMENTS, `${slot('statement', 'schema:url')}\n1`, route),
      body: {
        rank: 'preferred',
        value: { type: 'value', content: 'https://example.org/kokoro' },
        qualifiers: [],
        references: [],
      },
    },
  ]);
  expect(facts.find((fact) => fact.property === 'schema:numberOfPages')!.body).toEqual({
    rank: 'normal',
    value: { type: 'value', content: { amount: '+384', unit: '1' } },
    qualifiers: [],
    references: [],
  });
});

test('resolving the facts gives back the item in the Wikibase shape', () => {
  const dataType = (id: string) => dataTypes[id]!;
  const snak = (input: { property: { id: string }; value: unknown }) => ({
    property: { id: input.property.id, data_type: dataType(input.property.id) },
    value: input.value,
  });
  const hash = createHash('sha256')
    .update(canonical([{ property: 'schema:url', value: source.value }]))
    .digest('hex');
  const reference = { hash, parts: [snak(source)] };
  const facts = itemFacts(subjectId, book);
  const id = (property: string, seq: number) =>
    facts.find((fact) => fact.property === property && fact.log_seq === seq)!.statement_id;
  const statement = (property: string, seq: number, references: unknown[] = []) => {
    const input = (book.statements as Record<string, Record<string, unknown>[]>)[property]![seq - 1]!;
    return {
      id: id(property, seq),
      rank: input.rank ?? 'normal',
      ...snak(input as { property: { id: string }; value: unknown }),
      qualifiers: ((input.qualifiers as { property: { id: string }; value: unknown }[] | undefined) ?? []).map(snak),
      references,
      rezics: { release: bundledDigest, revision: 1 },
    } as Statement;
  };
  expect(resolveItem(subjectId, facts)).toEqual({
    id: subjectId,
    type: 'bf:Instance',
    revision: 1,
    release: bundledDigest,
    context: GLOBAL_CONTEXT,
    resolution: {},
    relationCounts: {},
    sourceRecords: [],
    labels: book.labels,
    descriptions: book.descriptions,
    aliases: book.aliases,
    statements: {
      'schema:translator': [statement('schema:translator', 1, [reference]), statement('schema:translator', 2)],
      'schema:url': [statement('schema:url', 1)],
      'schema:isbn': [statement('schema:isbn', 1, [reference])],
      'schema:numberOfPages': [statement('schema:numberOfPages', 1)],
    },
  });
});

test('later facts in a slot replace terms and remove values', () => {
  const statement = (id: string, operation: 'assert' | 'retract', content: string): FactRow => ({
    kind: 'statement',
    language: null,
    property: 'schema:isbn',
    statement_id: id,
    operation,
    body: { rank: 'normal', value: { type: 'value', content }, qualifiers: [], references: [] },
  });
  const term = (kind: 'label' | 'description' | 'alias', operation: 'assert' | 'retract', body: string): FactRow => ({
    kind,
    language: 'en',
    property: null,
    statement_id: null,
    operation,
    body,
  });
  const first = newId(route);
  const second = newId(route);
  const item = resolveItem(subjectId, [
    term('label', 'assert', 'Kokoro'),
    term('label', 'assert', 'Kokoro: A Novel'),
    term('description', 'assert', 'novel'),
    term('description', 'retract', 'novel'),
    term('alias', 'assert', 'Heart'),
    term('alias', 'assert', 'The Heart'),
    term('alias', 'retract', 'Heart'),
    statement(first, 'assert', '4-10-101013-0'),
    statement(second, 'assert', '978-4-10-101013-7'),
    statement(first, 'retract', '4-10-101013-0'),
  ]);
  expect(item.labels).toEqual({ en: 'Kokoro: A Novel' });
  expect(item.descriptions).toEqual({});
  expect(item.aliases).toEqual({ en: ['The Heart'] });
  expect(item.statements['schema:isbn']!.map((entry) => [entry.id, entry.value])).toEqual([
    [second, { type: 'value', content: '978-4-10-101013-7' }],
  ]);
  const emptied = resolveItem(subjectId, [
    term('label', 'assert', 'x'),
    term('alias', 'assert', 'y'),
    term('alias', 'retract', 'y'),
  ]);
  expect(emptied.aliases).toEqual({});
});

test('invalid input is refused with pointed violations', () => {
  const cases: [unknown, { pointer: string; code: string }[]][] = [
    [{ descriptions: { en: 'no label' } }, [{ pointer: '/labels', code: 'required' }]],
    [{ labels: {} }, [{ pointer: '/labels', code: 'required' }]],
    [{ labels: { en: 'x' }, sitelinks: {} }, [{ pointer: '/sitelinks', code: 'unknown_field' }]],
    [{ labels: { English: 'x', en: 'x' } }, [{ pointer: '/labels/English', code: 'invalid_format' }]],
    [{ labels: { en: 3 } }, [{ pointer: '/labels/en', code: 'invalid_type' }]],
    [{ labels: { en: ' padded' } }, [{ pointer: '/labels/en', code: 'invalid_format' }]],
    [{ labels: { en: 'x'.repeat(251) } }, [{ pointer: '/labels/en', code: 'out_of_range' }]],
    [{ labels: { en: 'x' }, aliases: { en: ['a', 'a'] } }, [{ pointer: '/aliases/en/1', code: 'invalid_format' }]],
    [
      { labels: { en: 'x' }, statements: { 'schema:homepage': [] } },
      [{ pointer: '/statements/schema:homepage', code: 'unsupported' }],
    ],
    [
      {
        type: 'schema:Book',
        labels: { en: 'x' },
        statements: {
          'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: 'Q42' } }],
        },
      },
      [{ pointer: '/statements/schema:author/0/value/content', code: 'invalid_format' }],
    ],
    [
      {
        type: 'bf:Instance',
        labels: { en: 'x' },
        statements: { 'schema:isbn': [{ property: { id: 'schema:translator' }, value: { type: 'novalue' } }] },
      },
      [{ pointer: '/statements/schema:isbn/0/property/id', code: 'invalid_format' }],
    ],
    [
      {
        type: 'bf:Instance',
        labels: { en: 'x' },
        statements: { 'schema:isbn': [{ property: { id: 'schema:isbn' }, value: { type: 'value' } }] },
      },
      [{ pointer: '/statements/schema:isbn/0/value/content', code: 'required' }],
    ],
    [
      {
        type: 'bf:Instance',
        labels: { en: 'x' },
        statements: { 'schema:isbn': [{ property: { id: 'schema:isbn' }, value: { type: 'novalue' }, rank: 'best' }] },
      },
      [{ pointer: '/statements/schema:isbn/0/rank', code: 'invalid_format' }],
    ],
    [
      {
        labels: { en: 'x' },
        statements: {
          'schema:url': [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'ftp://example.org/kokoro' } },
          ],
        },
      },
      [{ pointer: '/statements/schema:url/0/value/content', code: 'invalid_format' }],
    ],
    [
      {
        type: 'bf:Instance',
        labels: { en: 'x' },
        statements: {
          'schema:numberOfPages': [
            {
              property: { id: 'schema:numberOfPages' },
              value: { type: 'value', content: { amount: '384', unit: '1' } },
            },
          ],
        },
      },
      [{ pointer: '/statements/schema:numberOfPages/0/value/content/amount', code: 'invalid_format' }],
    ],
    [
      {
        type: 'bf:Instance',
        labels: { en: 'x' },
        statements: {
          'schema:isbn': [
            {
              property: { id: 'schema:isbn' },
              value: { type: 'novalue' },
              qualifiers: [{ property: { id: 'schema:publisher' }, value: { type: 'novalue' } }],
              references: [{ parts: [] }],
            },
          ],
        },
      },
      [
        { pointer: '/statements/schema:isbn/0/qualifiers/0/property/id', code: 'unsupported' },
        { pointer: '/statements/schema:isbn/0/references/0/parts', code: 'out_of_range' },
      ],
    ],
    [
      {
        type: 'bf:Instance',
        labels: { en: 'x' },
        statements: {
          'schema:isbn': Array.from({ length: 33 }, (_, n) => ({
            property: { id: 'schema:isbn' },
            value: { type: 'value', content: `isbn-${n}` },
          })),
        },
      },
      [{ pointer: '/statements/schema:isbn', code: 'out_of_range' }],
    ],
  ];
  for (const [input, violations] of cases) {
    const error = (() => {
      try {
        itemFacts(subjectId, input);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(SubjectInputError);
    expect(error).toMatchObject({ name: 'SubjectInputError' });
    expect((error as SubjectInputError).violations).toEqual(expect.arrayContaining(violations));
  }
});

test('violations are capped at sixteen and an item is capped at 512 facts', () => {
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`x-${n}`, ' bad']));
  const error = (() => {
    try {
      itemFacts(subjectId, { labels: many });
    } catch (caught) {
      return caught as SubjectInputError;
    }
  })();
  expect(error?.violations).toHaveLength(16);
  const languages = Array.from({ length: 17 }, (_, n) => `xx-${n}`);
  const aliases = Object.fromEntries(
    languages.map((language) => [language, Array.from({ length: 31 }, (_, n) => `alias ${n}`)]),
  );
  expect(() => itemFacts(subjectId, { labels: { en: 'x' }, aliases })).toThrow(SubjectInputError);
  const fits = Object.fromEntries(
    languages.slice(1).map((language) => [language, Array.from({ length: 31 }, (_, n) => `alias ${n}`)]),
  );
  expect(itemFacts(subjectId, { labels: { en: 'x' }, aliases: fits })).toHaveLength(497);
  expect(() => itemFacts('not-an-id', { labels: { en: 'x' } })).toThrow(RangeError);
});
