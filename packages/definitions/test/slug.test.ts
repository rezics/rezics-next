import { expect, test } from 'bun:test';
import { slug, subjectSlug } from '@rezics/definitions/slug';

test('slug keeps native Unicode and follows the shared separator contract', () => {
  for (const [label, expected] of [
    ['  The  Left-Hand / of Darkness  ', 'the-left-hand-of-darkness'],
    ['ＡＢＣ　１２３', 'abc-123'],
    ['三体：黑暗森林', '三体-黑暗森林'],
    ['君の名は。', '君の名は'],
    ['한글 제목', '한글-제목'],
    ['Cafe\u0301 déjà vu', 'café-déjà-vu'],
    ['İstanbul', 'i\u0307stanbul'],
    ['../<script> / \u0000', 'script'],
    [' -- 🍜 --- ', 'subject'],
    ['', 'subject'],
  ])
    expect(slug(label!)).toBe(expected!);
});

test('slug limits code points and cuts at a word boundary', () => {
  expect(slug('界'.repeat(61))).toBe('界'.repeat(60));
  expect(slug('𠮷'.repeat(61))).toBe('𠮷'.repeat(60));
  expect(slug(`${'a'.repeat(30)} ${'b'.repeat(40)}`)).toBe('a'.repeat(30));
  expect(slug(`${'a'.repeat(59)} b`)).toBe('a'.repeat(59));
  expect(slug('a'.repeat(60))).toBe('a'.repeat(60));
  expect(Array.from(slug('𠮷'.repeat(100))).length).toBe(60);
});

test('slug is stable and its subject alias is identical', () => {
  expect(subjectSlug).toBe(slug);
  for (const label of ['三体', 'A Very Long Title '.repeat(10), 'Résumé', 'İstanbul', '🍜']) {
    const result = slug(label);
    expect(slug(label)).toBe(result);
    expect(subjectSlug(label)).toBe(result);
    expect(slug(result)).toBe(result);
    expect(result).not.toMatch(/[/\\?#%\s]/u);
  }
});
