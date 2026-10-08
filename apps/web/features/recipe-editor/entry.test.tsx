import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { englishMessages } from '../work-page/messages.ts';
import { RecipeExperience } from '../work-page/types/recipe.tsx';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { createdWorkPath, editingHref, studioHref, textHref, workHref } from '../studio/agent.ts';
import { agents, ids, inventory, now, workHeader } from '../studio/fixtures.ts';
import { messages as studioMessages } from '../studio/messages.ts';
import { StudioHome } from '../studio/studio-home.tsx';
import { StudioWork } from '../studio/studio-work.tsx';
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

const cook = agents[0]!;
const recipeText = { id: ids.texts.recipe, revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000302' };

test('a recipe opens in the recipe editor from the work list and the work page, and other kinds keep their editors', () => {
  seedServedTypes();
  expect(editingHref(cook, ids.recipe, 'recipe', { language: 'en', text: recipeText })).toBe(recipeEditHref(ids.recipe));
  expect(editingHref(cook, ids.recipe, 'recipe', { language: 'ja' })).toBe(recipeEditHref(ids.recipe));
  expect(editingHref(cook, ids.story, 'document', { language: 'en', text: { id: ids.texts.story, revision: recipeText.revision } }))
    .toBe(textHref(cook, ids.story, ids.texts.story, recipeText.revision));
  expect(editingHref(cook, ids.serial, 'book', { language: 'zh-Hans' })).toBe(workHref(cook, ids.serial, 'chapters'));
  expect(editingHref(cook, ids.serial, 'book', { language: 'zh-Hans', text: { id: ids.texts.serial, revision: recipeText.revision },
    introduction: true })).toBe(textHref(cook, ids.serial, ids.texts.serial, recipeText.revision));

  const home = renderToStaticMarkup(createElement(StudioHome, {
    agent: cook, content: { view: 'all', works: { ok: true, data: inventory } }, moreHref: null, now, locale: 'en',
    messages: studioMessages,
  }));
  const recipeItem = home.slice(home.indexOf('Ginger lemon tea'));
  expect(recipeItem).toContain(localizedPath(recipeEditHref(ids.recipe), 'en'));
  expect(recipeItem).not.toContain('/write');
  const guideItem = home.slice(home.indexOf('The Cartographer of Tides'), home.indexOf('Ginger lemon tea'));
  expect(guideItem).toContain('/write/');
  expect(home.slice(home.indexOf('雨夜书店'), home.indexOf('The Cartographer of Tides'))).toContain('tab=chapters');

  const recipe = {
    header: workHeader(ids.recipe, 'Ginger lemon tea', 'en', 'recipe'),
    metadata: { ok: true as const, data: { work: ids.recipe, revision: null, originalTitle: null, completionStatus: null,
      localized: [], sourcePosition: { dataEpoch: 'story', sequence: '42' } } },
  };
  const page = renderToStaticMarkup(createElement(StudioWork, {
    agent: cook, work: recipe as never, languages: ['en'], locale: 'en', messages: studioMessages,
    content: { tab: 'text', texts: { ok: true, data: [{ id: recipeText.id, work: null, revision: recipeText.revision,
      language: 'en', publication: 'public' }] } },
  }));
  expect(page).toContain(localizedPath(recipeEditHref(ids.recipe), 'en'));
  expect(page).not.toContain('/write');
  const fresh = renderToStaticMarkup(createElement(StudioWork, {
    agent: cook, work: recipe as never, languages: ['en'], locale: 'en', messages: studioMessages,
    content: { tab: 'text', texts: { ok: true, data: [] } },
  }));
  expect(fresh).toContain(localizedPath(recipeEditHref(ids.recipe), 'en'));
  expect(fresh).not.toContain('/write');
});
