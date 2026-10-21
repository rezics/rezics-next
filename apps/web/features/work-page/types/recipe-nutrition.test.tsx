import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { messages } from '../messages.ts';
import { RecipeContent, RecipeNutritionSources } from './recipe.tsx';
import { nutrientNames, nutritionEvidence, nutritionPage } from './recipe-nutrition.fixtures.ts';
import { recipeNutritionMessages } from './recipe-nutrition-messages.ts';

test('native nutrient observations retain exact amounts, basis, coverage and provenance without evidence links in the table', () => {
  const html = renderToStaticMarkup(<RecipeContent page={nutritionPage()} units="written" messages={messages.en}
    names={nutrientNames} authors={['Declared recipe author']} nutritionKnown />);
  expect(html).toContain('>Nutrition</h3>');
  for (const label of ['Energy', 'Protein', 'Fibre', 'Per serving', 'Whole recipe', 'complete', 'partial', 'unknown',
    'source-stated', 'declared', 'computed', '210 ½ kcal', '15 g', '0 g']) expect(html).toContain(label);
  expect(html).not.toContain('2 min');
  expect(html.match(/data-source-key=/g)).toHaveLength(2);
  expect(html).toContain(`data-source-key="${nutritionEvidence}"`);
  expect(html).not.toContain(`href="${nutritionEvidence}"`);
  expect(html).not.toContain(messages.en.recipeNutritionNotProvided);
  expect(html).not.toMatch(/healthy|healthier|low-fat|zero calories/i);
});

test('nutrient amounts retain exact non-kitchen rationals and never acquire an invented duration unit', () => {
  const page = nutritionPage();
  const html = renderToStaticMarkup(<RecipeContent page={{ ...page, measures: [{ ...page.measures[1]!,
    value: { numerator: 1, denominator: 7 }, unitText: undefined }] }} units="written" messages={messages.en} />);
  expect(html).toContain('>1/7</td>');
  expect(html).not.toContain('⅛');
  expect(html).not.toContain('>1/7 min</td>');
});

test('declared substitution links retain authored target order and actual authors without inferring from ingredient names', () => {
  const page = nutritionPage();
  const html = renderToStaticMarkup(<RecipeContent page={page} units="written" messages={messages.en}
    authors={['Actual recipe author']} />);
  expect(html).toContain('Author-declared substitutions');
  expect(html).toContain('Actual recipe author');
  expect([...html.matchAll(/data-occurrence="([^"]+)"/g)].map(match => match[1]))
    .toEqual([page.ingredients[1]!.occurrence, page.ingredients[0]!.occurrence]);
  for (const ingredient of page.ingredients) expect(html).toContain(`id="recipe-ingredient-${ingredient.occurrence}"`);
  const unknown = renderToStaticMarkup(<RecipeContent page={page} units="written" messages={messages.en} />);
  expect(unknown).toContain(messages.en.unknownAuthor);
  expect(unknown).not.toContain('Actual recipe author');
});

test('footer evidence deduplicates the exact supplied identity and never creates an evidence URL', () => {
  const page = nutritionPage();
  const html = renderToStaticMarkup(<RecipeNutritionSources page={page} names={nutrientNames} messages={messages.en} />);
  expect(html.match(/data-source-key=/g)).toHaveLength(1);
  expect(html.match(new RegExp(`href="${nutritionEvidence}"`, 'g'))).toHaveLength(1);
  expect(html).toContain('Nutrition');
  expect(html).toContain('Energy');
  expect(html).toContain('Protein');
  expect(html).not.toContain('Fibre');
  for (const evidence of ['javascript:alert(1)', 'https://rezics.com/id/00000000-0000-4000-8000-000000000010']) {
    const source = renderToStaticMarkup(<RecipeNutritionSources page={{ ...page, measures: [{ ...page.measures[1]!, evidence }] }} messages={messages.en} />);
    expect(source).not.toContain('href=');
  }
});

test('unknown names and absent observations do not become fabricated names, zero nutrients or declared absence', () => {
  const page = nutritionPage();
  const unnamed = renderToStaticMarkup(<RecipeContent page={page} units="written" messages={messages.en} />);
  expect(unnamed).toContain(recipeNutritionMessages.en.unnamedNutrient);
  expect(unnamed).not.toContain('>Energy<');
  expect(unnamed).not.toContain(`>${page.measures[1]!.nutrient!}<`);
  const empty = { ...page, measures: [] };
  const known = renderToStaticMarkup(<RecipeContent page={empty} units="written" messages={messages.en} nutritionKnown />);
  expect(known).toContain(messages.en.recipeNutritionNotProvided);
  const unknown = renderToStaticMarkup(<RecipeContent page={empty} units="written" messages={messages.en} />);
  expect(unknown).not.toContain(messages.en.recipeNutrition);
});
