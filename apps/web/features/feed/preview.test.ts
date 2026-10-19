import { expect, test } from 'bun:test';
import { post, storyId } from './fixtures.ts';
import { feedExcerpt } from './preview.ts';

const title = '25. Minestra di mattoncini di ricotta';
const recipe = (excerpt: string | null) => post(1, {
  card: { kind: 'recipe' }, target: { title: { ...post(1).target.title, value: title }, excerpt },
});

test('recipe previews spend their lines on supplied ingredients rather than the repeated heading', () => {
  for (const excerpt of [
    `${title}\nIngredients\nRicotta, eggs and broth.`,
    `${title} Ingredients Ricotta, eggs and broth.`,
    `${title}\n\nIngredients: Ricotta, eggs and broth.`,
    `  ${title}\r\nIngredients\r\nRicotta, eggs and broth.  `,
    `${title}: Ingredients: Ricotta, eggs and broth.`,
    `${title}\nRicotta, eggs and broth.`,
  ]) expect(feedExcerpt(recipe(excerpt))).toBe('Ricotta, eggs and broth.');
});

test('a heading without body can be omitted without manufacturing a description', () => {
  for (const excerpt of [null, '', title, 'Ingredients', `${title}\nIngredients`, `${title} Ingredients:`])
    expect(feedExcerpt(recipe(excerpt))).toBeNull();
});

test('books and guides retain new information and meaningful sentences that begin with their title', () => {
  for (const [heading, excerpt, expected] of [
    ['Middlemarch', 'Middlemarch\nA study of provincial life.', 'A study of provincial life.'],
    ['Reading guide', 'Reading guide: Compare the two narrators.', 'Compare the two narrators.'],
    ['Middlemarch', 'Middlemarch explores provincial life. Middlemarch rewards rereading.',
      'Middlemarch explores provincial life. Middlemarch rewards rereading.'],
    [title, `${title} is served in broth.`, `${title} is served in broth.`],
    ['Ingredients', 'Ingredients are measured by weight.', 'Ingredients are measured by weight.'],
    ['Cooking', 'Cooking\nIngredients are measured by weight.', 'Ingredients are measured by weight.'],
    ['雨夜书店', '雨夜书店\n雨停之后，书店的灯还亮着。', '雨停之后，书店的灯还亮着。'],
  ]) {
    expect(feedExcerpt(post(2, { target: { title: { ...post(2).target.title, value: heading! }, excerpt } })))
      .toBe(expected!);
  }
});

test('chapter and release excerpts describe their own events, even when they name the Work', () => {
  const chapter = post(3, { card: { kind: 'chapter', occurrence: storyId(31, 'dddd'), parent: storyId(3, 'eeee'),
    number: 1, excerpt: 'Work 3\nThe opening scene.' } });
  expect(feedExcerpt(chapter)).toBe('Work 3\nThe opening scene.');
  const release = post(4, { card: { kind: 'release', changelogExcerpt: 'Work 4\nFixes saved games.' } });
  expect(feedExcerpt(release)).toBe('Work 4\nFixes saved games.');
});
