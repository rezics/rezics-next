import { expect, test } from 'bun:test';
import { parseStrictJson } from '../../src/http/strict-json.ts';

const duplicates = [
  '{"a":1,"a":2}',
  '{"":0,"":1}',
  '{"outer":{"a":1,"a":2}}',
  '[0,{"a":1,"a":2}]',
  '{"a":0,"b":[{"c":0,"c":1}]}',
  String.raw`{"a":1,"\u0061":2}`,
  String.raw`{"\u0061":1,"a":2}`,
  String.raw`{"é":1,"\u00e9":2}`,
  String.raw`{"${'😀'}":1,"\ud83d\ude00":2}`,
  String.raw`{"\ud800":1,"\uD800":2}`,
  String.raw`{"\n":1,"\u000a":2}`,
  String.raw`{"\"":1,"\u0022":2}`,
  String.raw`{"\\":1,"\u005c":2}`,
  '{"__proto__":{},"__proto__":null}',
  String.raw`{"constructor":1,"\u0063onstructor":2}`,
  '{"toString":0,"toString":1}',
];

for (const text of duplicates) {
  test(`rejects repeated decoded member names: ${text}`, () => {
    // Native parsing accepts and collapses these: the guard must retain wire evidence.
    expect(() => JSON.parse(text)).not.toThrow();
    expect(() => parseStrictJson(text)).toThrow(SyntaxError);
  });
}

const valid = [
  '{}',
  '[]',
  'null',
  'true',
  'false',
  '1e400',
  '-0',
  '123.45e-6',
  '"a string"',
  '[null,true,false,0,"x",{},[]]',
  '{"a":1,"A":2}',
  '{"a":{"x":1},"b":{"x":2},"x":3}',
  '[{"x":1},{"x":2}]',
  '{"":{},"a":{"":[]}}',
  String.raw`{"é":1,"e\u0301":2}`,
  String.raw`{"a":"escaped quote: \" }, { [ ], : and \\","b":"{\"x\":1,\"x\":2}"}`,
  String.raw`"{\"a\":1,\"a\":2}"`,
  String.raw`{"\u0061":1,"b":2}`,
  '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"toString":3}',
  ' \n\t\r { "a" \n\t\r : 1 } \r\n',
];

for (const text of valid) {
  test(`retains native decoding: ${text}`, () => {
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });
}

test('prototype-sensitive names remain own data properties', () => {
  const parsed = parseStrictJson('{"__proto__":{"polluted":true},"constructor":1}') as object;
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
  expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toEqual({ polluted: true });
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});

for (const text of [
  '',
  ' ',
  '{',
  '[1,]',
  '{"a":1,}',
  '{a:1}',
  '{"a" 1}',
  '01',
  'NaN',
  'undefined',
  '{} trailing',
  '{}{}',
  '"unterminated',
  '"raw\nnewline"',
  String.raw`"\x61"`,
  String.raw`"\u00xy"`,
  '{/*comment*/"a":1}',
  '\u00a0{}',
]) {
  test(`retains native syntax rejection: ${JSON.stringify(text)}`, () => {
    expect(() => JSON.parse(text)).toThrow(SyntaxError);
    expect(() => parseStrictJson(text)).toThrow(SyntaxError);
  });
}

test('deep bounded input uses no recursive guard or arbitrary depth cap', () => {
  const depth = 20_000;
  const text = '{"x":'.repeat(depth) + '0' + '}'.repeat(depth);
  expect(() => parseStrictJson(text)).not.toThrow();
  const duplicate = '{"x":'.repeat(depth) + '{"a":0,"a":1}' + '}'.repeat(depth);
  expect(() => parseStrictJson(duplicate)).toThrow(SyntaxError);
});
