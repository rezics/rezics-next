import { expect, test } from 'bun:test';
import { assertJsonByteBudget } from '../src/components/editor-json-budget.ts';
import { assertSnapshotSize } from '../src/components/rich-text-editor-snapshot.ts';

test('streaming JSON budget agrees with UTF8 serialization including keys, escapes and surrogate boundaries', () => {
  for (const value of [
    null,
    true,
    false,
    -0,
    2.3e-20,
    [],
    {},
    ['😀', '\ud800', '\udc00', '\u0000\n\\"'],
    { '鍵😀': ['a', { '': 'x\u2028' }] },
  ]) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(() => assertJsonByteBudget(value, bytes)).not.toThrow();
    expect(() => assertJsonByteBudget(value, bytes - 1)).toThrow(RangeError);
  }
});

test('shared large attrs are refused by actual resulting runs before string serialization or normalization', () => {
  const color = 'x'.repeat(1_000_000);
  const text = { type: 'text', text: 'a', marks: [{ type: 'textStyle', attrs: { color } }] };
  const snapshot = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: Array.from({ length: 20_000 }, (_, index) => ({
        type: 'paragraph',
        attrs: { id: `p${index}` },
        content: [text],
      })),
    },
  };
  expect(() => assertSnapshotSize(snapshot as never)).toThrow(RangeError);
  expect(() =>
    assertSnapshotSize({ ...snapshot, doc: { type: 'doc', content: [snapshot.doc.content[0]] } } as never),
  ).not.toThrow();
  let read = false;
  expect(() =>
    assertJsonByteBudget(
      {
        get privateValue() {
          read = true;
          return 'x';
        },
      },
      100,
    ),
  ).toThrow(TypeError);
  expect(read).toBe(false);
});
