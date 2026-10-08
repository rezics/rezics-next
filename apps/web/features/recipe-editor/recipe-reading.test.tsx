import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiLocales } from '../../i18n/define.ts';
import { englishMessages as pageMessages } from '../work-page/messages.ts';
import { RecipeContent, type ReadableRecipe } from '../work-page/types/recipe.tsx';
import { qualifierOf, parseLine } from './ingredient-line.ts';
import { copyOf } from './messages.ts';
import type { RecipeState } from './model.ts';
import { Preview } from './preview.tsx';
import { readingOf } from './reading.ts';

const flourId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000022';
const stepId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000013';
const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000008';

const state: RecipeState = {
  structure, head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000900',
  nodes: [
    { occurrence: flourId, parent: structure, role: 'ingredient', qualifier: qualifierOf(parseLine('1 1/2 cups flour, sifted'), 'en') },
    { occurrence: stepId, parent: structure, role: 'step', qualifier: {
      type: 'recipe-step', instructionText: { value: 'Fold in the flour.', language: 'en' },
      usesIngredient: [flourId], media: [], scaling: 'linear' } },
  ],
  measures: [
    { kind: 'yield', value: { numerator: 12, denominator: 1 }, unitText: 'muffins' },
    { kind: 'preparation-duration', value: { numerator: 3, denominator: 2 }, unitText: 'min' },
    { kind: 'cooking-duration', value: { numerator: 90, denominator: 1 }, unitText: 's' },
  ],
};

const published: ReadableRecipe = {
  ingredients: [{ occurrence: flourId, originalText: '1 1/2 cups flour, sifted', line: '1 ½ cups flour, sifted' }],
  occurrences: [
    { occurrence: flourId, role: 'ingredient', parent: structure, labels: [] },
    { occurrence: stepId, role: 'step', parent: structure, labels: [], qualifier: {
      type: 'recipe-step', instructionText: { value: 'Fold in the flour.' }, usesIngredient: [flourId] } },
  ],
  measures: [
    { kind: 'yield', value: { numerator: 12, denominator: 1 }, unitText: 'muffins' },
    { kind: 'preparation-duration', value: { numerator: 3, denominator: 2 }, unitText: 'min' },
    { kind: 'cooking-duration', value: { numerator: 90, denominator: 1 }, unitText: 's' },
  ],
};

const minutesNames = {
  en: 'minutes', 'zh-Hant': '分鐘', 'zh-Hans': '分钟', ja: '分', ko: '분', de: 'Minuten', fr: 'minutes', es: 'minutos',
} as const;

test('the preview and the work page read one quantity, the stored timing, and a step’s ingredients', () => {
  const preview = renderToStaticMarkup(createElement(Preview, {
    state, title: 'Muffins', description: 'Bright.', notes: 'Tomorrow.', language: 'en', t: copyOf('en'), messages: pageMessages,
  }));
  const page = renderToStaticMarkup(createElement(RecipeContent, {
    page: published, units: 'written', messages: pageMessages, notes: 'Tomorrow.',
  }));
  for (const html of [preview, page]) {
    expect(html).toContain('1 ½ cups flour, sifted');
    expect(html).not.toContain('1 1/2');
    expect(html).toContain('Fold in the flour.');
    expect(html).toContain('12 muffins');
    expect(html).toContain('1 ½ min');
    expect(html).toContain('90 s');
    expect(html).toContain('Tomorrow.');
    expect(html.split('1 ½ cups flour, sifted')).toHaveLength(3);
  }
  expect(readingOf(state).ingredients[0]?.line).toBe('1 ½ cups flour, sifted');
});

test('every locale names the minutes of a time field', () => {
  for (const locale of uiLocales) expect(copyOf(locale).minutesName).toBe(minutesNames[locale]);
});
