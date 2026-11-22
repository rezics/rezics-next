import { expect, test } from 'bun:test';
import { tree, treeByteLength } from '../../src/search/public-filter-codec.ts';

test('metered bytes equal the persisted tagged UTF-8 encoding', () => {
  const strings = ['', 'en', '日本語', '🌱', '\ud800', '\udfff', 'a"b\\c', '\n\t\u0000\u001f'];
  const values = [
    null,
    undefined,
    true,
    false,
    -0,
    -1.25e-22,
    234567890123456789n,
    ...strings,
    Object.fromEntries(strings.map((key, index) => [key, [index, strings[index]]])),
    [undefined, , { earlier: [], later: 0n }],
    new Date('2026-01-01'),
    new Uint8Array([0, 1, 255]),
  ];
  for (const tag of ['scalar', 'value'] as const) {
    for (const value of values)
      expect(treeByteLength(value, tag)).toBe(Buffer.byteLength(JSON.stringify(tree(value, tag))));
  }
  for (const value of [NaN, Infinity, Symbol('key'), () => undefined]) {
    expect(() => treeByteLength(value)).toThrow(TypeError);
    expect(treeByteLength(value, 'value')).toBe(Buffer.byteLength(JSON.stringify(['value', value])));
  }
});
