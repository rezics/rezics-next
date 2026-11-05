import { expect, test } from 'bun:test';
import {
  compileText,
  parseText,
  positiveText,
  TEXT_LIMITS,
  TextSyntaxError,
  type TextNode,
} from '../../src/search/text.ts';

const term = (value: string): TextNode => ({ kind: 'term', value });
const phrase = (value: string): TextNode => ({ kind: 'phrase', value });
const and = (...children: TextNode[]): TextNode => ({ kind: 'and', children });
const or = (...children: TextNode[]): TextNode => ({ kind: 'or', children });
const not = (child: TextNode): TextNode => ({ kind: 'not', child });

function failure(input: string): TextSyntaxError {
  try {
    parseText(input);
  } catch (error) {
    expect(error).toBeInstanceOf(TextSyntaxError);
    return error as TextSyntaxError;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
}

test('adjacent terms are AND, bar is OR, minus is NOT, quotes are phrases, and NOT binds tighter than AND tighter than OR', () => {
  expect(parseText('魔法 禁書')).toEqual(and(term('魔法'), term('禁書')));
  expect(parseText('a b | c')).toEqual(or(and(term('a'), term('b')), term('c')));
  expect(parseText('a -b')).toEqual(and(term('a'), not(term('b'))));
  expect(parseText('"禁書 目録" | -(a | b) c')).toEqual(
    or(phrase('禁書 目録'), and(not(or(term('a'), term('b'))), term('c'))),
  );
  expect(parseText('  single  ')).toEqual(term('single'));
  expect(parseText('foo-bar')).toEqual(term('foo-bar'));
  expect(parseText('a　b')).toEqual(and(term('a'), term('b')));
  expect(parseText('a (b c) d')).toEqual(and(term('a'), term('b'), term('c'), term('d')));
  expect(parseText('(a|b)|c')).toEqual(or(term('a'), term('b'), term('c')));
});

test('backslash escapes only the six syntax characters', () => {
  expect(parseText('\\"quoted\\" \\-minus \\| \\( \\) \\\\')).toEqual(
    and(term('"quoted"'), term('-minus'), term('|'), term('('), term(')'), term('\\')),
  );
  expect(parseText('"say \\"hi\\""')).toEqual(phrase('say "hi"'));
  for (const input of ['\\x', 'a\\', '\\n', '"\\a"']) expect(failure(input).code).toBe('unsupported');
});

test('malformed queries are typed rejections, never partial queries', () => {
  const inputs = ['', '   ', '"unclosed', 'a "b', '()', '( )', 'a | | b', '| a', 'a |', '-', 'a -', '--a', '-|a'];
  for (const input of [...inputs, '(a', 'a)', ')(', '""', '-""', 'a -) b']) {
    expect(failure(input).code).toBe('unsupported');
  }
});

test('limits are UTF-8 bytes, leaves, depth and phrase tokens', () => {
  expect(TEXT_LIMITS).toEqual({ bytes: 512, depth: 4, leaves: 64, phraseTokens: 32 });
  expect(parseText('魔'.repeat(170))).toEqual(term('魔'.repeat(170)));
  expect(failure('魔'.repeat(171)).code).toBe('out_of_range');
  const terms = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`).join(' ');
  expect(() => parseText(terms(64))).not.toThrow();
  expect(failure(terms(65)).code).toBe('out_of_range');
  expect(parseText('(((( a ))))')).toEqual(term('a'));
  expect(failure('((((( a )))))').code).toBe('out_of_range');
  expect(() => parseText(`"${'字'.repeat(32)}"`)).not.toThrow();
  expect(failure(`"${'字'.repeat(33)}"`).code).toBe('out_of_range');
  const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ');
  expect(() => parseText(`"${words(32)}"`)).not.toThrow();
  expect(failure(`"${words(33)}"`).code).toBe('out_of_range');
});

test('errors name the offending position', () => {
  expect(failure('a "b').offset).toBe(2);
  expect(failure('ab \\x').offset).toBe(3);
  expect(failure('a)').offset).toBe(1);
  expect(failure('a | | b').offset).toBe(4);
});

test('a query is positive only when every OR branch has a positive leaf outside negation', () => {
  expect(positiveText(parseText('a -b'))).toBe(true);
  expect(positiveText(parseText('-a'))).toBe(false);
  expect(positiveText(parseText('-a -b'))).toBe(false);
  expect(positiveText(parseText('a | -b'))).toBe(false);
  expect(positiveText(parseText('(a -b) | "c d"'))).toBe(true);
  expect(positiveText(parseText('-(a | b) c'))).toBe(true);
});

test('compiles to named match and match_phrase clauses with lineage', () => {
  const compiled = compileText(parseText('魔法 | "禁書 目録" -外伝'), { field: 'search_text', prefix: 't' });
  expect(compiled.query).toEqual({
    bool: {
      should: [
        { match: { search_text: { query: '魔法', operator: 'and', _name: 't0' } } },
        {
          bool: {
            must: [{ match_phrase: { search_text: { query: '禁書 目録', _name: 't1' } } }],
            must_not: [{ match: { search_text: { query: '外伝', operator: 'and', _name: 't2' } } }],
          },
        },
      ],
      minimum_should_match: 1,
    },
  });
  expect(compiled.leaves).toEqual([
    { name: 't0', kind: 'term', value: '魔法', negated: false },
    { name: 't1', kind: 'phrase', value: '禁書 目録', negated: false },
    { name: 't2', kind: 'term', value: '外伝', negated: true },
  ]);
  expect(compileText(parseText('-a'), { field: 'f', prefix: 'q' })).toEqual({
    query: { bool: { must_not: [{ match: { f: { query: 'a', operator: 'and', _name: 'q0' } } }] } },
    leaves: [{ name: 'q0', kind: 'term', value: 'a', negated: true }],
  });
  expect(compileText(parseText('"a b"'), { field: 'f', prefix: 'q' }).query).toEqual({
    match_phrase: { f: { query: 'a b', _name: 'q0' } },
  });
});

test('Unicode diagnostics use UTF-16 selection boundaries, code points and UTF-8 bytes separately', () => {
  expect(failure('😀 心 "こころ').diagnostic).toEqual({
    reason: 'unclosed_phrase',
    unit: 'utf16',
    start: 5,
    end: 6,
    codePointStart: 4,
    codePointEnd: 5,
    byteOffset: 9,
  });
  expect(failure('😀 \\界').diagnostic).toMatchObject({
    reason: 'unsupported_escape',
    start: 3,
    end: 5,
    codePointStart: 2,
    codePointEnd: 4,
    byteOffset: 5,
  });
  expect(failure('😀'.repeat(129)).diagnostic).toMatchObject({
    reason: 'byte_limit',
    start: 256,
    end: 258,
    codePointStart: 128,
    codePointEnd: 129,
    byteOffset: 512,
  });
  expect(failure('界'.repeat(171)).diagnostic).toMatchObject({
    reason: 'byte_limit',
    start: 170,
    end: 171,
    byteOffset: 510,
  });
  expect(failure('心 |').diagnostic).toMatchObject({ reason: 'expected_operand', start: 3, end: 3 });
  expect(failure('(こころ').diagnostic.reason).toBe('unclosed_group');
  expect(parseText('😀 心 "こころ"')).toEqual(and(term('😀'), term('心'), phrase('こころ')));
});
