import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { qualifierOf, parseLine } from './ingredient-line.ts';
import { plan } from './intents.ts';
import { emptyRecipe } from './model.ts';
import { recipeLanguage } from './authored-language.ts';

const page = () => readFileSync(new URL('./edit-page.tsx', import.meta.url), 'utf8');

test('a Japanese recipe with an English display title is written in Japanese', () => {
  // The header title is the one chosen for the reader. The label language is the Work's own.
  const language = recipeLanguage({ labelLanguage: 'ja', metadataTitles: true, headerTitleLanguage: 'en' });
  expect(language).toBe('ja');
  expect(qualifierOf(parseLine('バター'), language!).originalText.language).toBe('ja');
  expect(plan(emptyRecipe, { kind: 'addSection', label: '生地', language: language! })).toMatchObject({
    operations: [{ label: { value: '生地', language: 'ja' } }],
  });
  expect(plan(emptyRecipe, { kind: 'addStep', text: '混ぜる', language: language!, uses: [] })).toMatchObject({
    operations: [{ qualifier: { instructionText: { value: '混ぜる', language: 'ja' } } }],
  });
});

test('a display title is not the authored language when the label cannot be read', () => {
  expect(recipeLanguage({ labelLanguage: null, metadataTitles: true, headerTitleLanguage: 'en' })).toBeNull();
});

test('a new Work with no metadata title uses the label language the header still carries', () => {
  expect(recipeLanguage({ labelLanguage: null, metadataTitles: false, headerTitleLanguage: 'ja' })).toBe('ja');
  expect(recipeLanguage({ labelLanguage: 'ja', metadataTitles: false, headerTitleLanguage: 'en' })).toBe('ja');
});

test('the editor page does not take its language from the display title', () => {
  const source = page();
  expect(source).toContain('recipeLanguage(');
  expect(source).not.toMatch(/canonicalLanguage\(work\.title\.language\)/);
  expect(source).not.toContain('selectedLanguage');
});
