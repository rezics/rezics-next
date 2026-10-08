import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { englishMessages } from '../work-page/messages.ts';
import { RecipeExperience } from '../work-page/types/recipe.tsx';
import { createdWorkPath, studioHref, workHref } from '../studio/agent.ts';
import { idOf } from '../studio/types.ts';
import { recipeEditHref } from './route.ts';

const editorHref = recipeEditHref('00000000-0000-4000-8000-0000000000aa');

const agent = { iri: 'https://rezics.com/id/00000000-0000-4000-8000-000000000007', handle: 'cook' };
const created = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';

test('a recipe with no composition still offers Edit recipe to someone who may edit', () => {
  const html = renderToStaticMarkup(createElement(RecipeExperience, {
    initial: null, href: '/v1/recipes/works/example', actingSubject: null, text: 'A few notes.',
    edit: { href: editorHref, label: 'Edit recipe' }, locale: 'en', messages: englishMessages,
  }));
  expect(html).toContain('Edit recipe');
  expect(html).toContain('/edit/recipe');
  expect(html).toContain('A few notes.');
});

test('a recipe with no composition offers no editor to someone who may not edit', () => {
  const html = renderToStaticMarkup(createElement(RecipeExperience, {
    initial: null, href: '/v1/recipes/works/example', actingSubject: null, text: null,
    edit: null, locale: 'en', messages: englishMessages,
  }));
  expect(html).not.toContain('Edit recipe');
});

test('creating a recipe opens the recipe editor, and a book or other work keeps its own start', () => {
  expect(createdWorkPath(agent, created, 'recipe', 'en')).toBe(recipeEditHref(created));
  expect(createdWorkPath(agent, created, 'book', 'en')).toBe(workHref(agent, created, 'chapters'));
  expect(createdWorkPath(agent, created, 'document', 'zh-Hans')).toBe(
    `${studioHref(agent, `/works/${idOf(created)}/write`)}?language=zh-Hans`);
});
