import { expect, test } from 'bun:test';
import { authoredDocumentBody, checkedContentText, CONTENT_TEXT_COST } from '../src/document-body.ts';
import { extractProjectionText, projectionRecipeFor } from '../../main/src/modules/content-publication/projection-recipes.ts';
import { canonicalContentLanguage, type ExactContentReference } from '../src/core.ts';

for (const [body, language] of [
  ['中'.repeat(65_536), 'zh-Hans-u-nu-hanidec'],
  ['😀'.repeat(32_768), 'en-x-reader'],
  ['a'.repeat(65_536), 'de-DE-u-co-phonebk'],
  ['... !!!', 'en'], ['e\u0301 العربية 日本語', 'ar'],
] as const) test(`Content admission and projection share the Unicode budget: ${language}`, () => {
  expect(checkedContentText(body)).toBe(body);
  expect(canonicalContentLanguage(language)).toBe(language);
  const authored = authoredDocumentBody({ body }, CONTENT_TEXT_COST.textBytes);
  const reference = { language: { kind: 'tag', tag: language } } as ExactContentReference;
  const recipe = projectionRecipeFor('content-shape-v1');
  if (recipe.kind !== 'text') throw new Error('text recipe missing');
  expect(extractProjectionText(recipe, { ...authored }, reference)).toEqual({ text: body, language });
});

for (const body of ['a'.repeat(65_537), '😀'.repeat(32_769), '\ud800', 'a\0b']) {
  test('Content rejects text outside its admitted single-unit Unicode budget', () => {
    expect(() => checkedContentText(body)).toThrow();
    const recipe = projectionRecipeFor('content-shape-v1');
    if (recipe.kind !== 'text') throw new Error('text recipe missing');
    expect(() => extractProjectionText(recipe, { body }, {
      language: { kind: 'tag', tag: 'en' },
    } as ExactContentReference)).toThrow();
  });
}

test('Content canonicalization admits BCP 47 extensions and rejects noncanonical retained tags', () => {
  expect(canonicalContentLanguage('EN-us-U-NU-latn')).toBe('en-US-u-nu-latn');
  for (const language of ['en_US', '', 'en-u', 'x-private']) expect(() => canonicalContentLanguage(language)).toThrow();
  const recipe = projectionRecipeFor('content-shape-v1');
  if (recipe.kind !== 'text') throw new Error('text recipe missing');
  expect(() => extractProjectionText(recipe, { body: 'valid' }, {
    language: { kind: 'tag', tag: 'EN-us' },
  } as ExactContentReference)).toThrow();
});


test('canonical spelling may expand an admitted 100-unit original language tag', () => {
  const original = 'en-a-' + Array(9).fill('abcdefgh').join('-') + '-u-ca-islamicc';
  expect(original.length).toBeLessThanOrEqual(CONTENT_TEXT_COST.languageUnits);
  const canonical = canonicalContentLanguage(original);
  expect(canonical.length).toBeGreaterThan(100);
  expect(canonicalContentLanguage(canonical)).toBe(canonical);
  const recipe = projectionRecipeFor('content-shape-v1');
  if (recipe.kind !== 'text') throw new Error('text recipe missing');
  expect(extractProjectionText(recipe, { body: 'legal text' }, {
    language: { kind: 'tag', tag: canonical },
  } as ExactContentReference)).toEqual({ text: 'legal text', language: canonical });
});
