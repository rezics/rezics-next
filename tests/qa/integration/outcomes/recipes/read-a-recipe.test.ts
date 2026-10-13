import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import reading, { acting, originalRecipe, short, type RecipeWork } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let recipe: RecipeWork;
let hidden: RecipeWork;
let ownerHidden: RecipeWork;
type Page = { revision: string; structure: string; next?: string;
  occurrences: Array<{ occurrence: string; role: string; parent: string;
    labels: Array<{ value: string; language: string }>;
    qualifier?: { originalText?: { value: string; language: string }; instructionText?: { value: string; language: string } } }>;
  ingredients: Array<{ originalText: string; amount: { numerator: number; denominator: number } }>;
  measures: Array<{ kind: string }>; cost: { occurrences: number } };
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  recipe = await originalRecipe(sessions.owner, 'Original paged sauce', { paged: true, laterDraft: true });
  // A different author owns the hidden control, so none of the tested personas owns it.
  hidden = await originalRecipe(sessions.stranger, 'Hidden stranger sauce', { published: false });
  ownerHidden = await originalRecipe(sessions.owner, 'Hidden owner sauce', { published: false });
}, 240_000);
afterAll(async () => { await sessions?.close(); });

async function read(name: PersonaName) {
  const person = sessions[name];
  const path = `/v1/recipes/works/${short(recipe.work)}`;
  const query = new URLSearchParams(acting(person));
  query.set('servings', '8');
  const first = await answer<Page>(person.main('GET', `${path}?${query}`));
  expect(first.revision).toBe(recipe.revision);
  expect(first.structure).toBe(recipe.structure);
  expect(first.next).toBeString();
  expect(first.occurrences.slice(0, 3).map(item => item.role)).toEqual(['group', 'ingredient', 'ingredient']);
  expect(first.occurrences[0]?.labels).toContainEqual({ value: 'Sauce', language: 'en' });
  expect(first.occurrences[1]?.parent).toBe(first.occurrences[0]?.occurrence);
  expect(first.measures.map(item => item.kind)).toContain('servings');
  const pages = [first];
  // The cursor carries servings forward without resending them.
  query.delete('servings');
  while (pages.at(-1)!.next) {
    expect(pages.length).toBeLessThan(4);
    query.set('cursor', pages.at(-1)!.next!);
    pages.push(await answer<Page>(person.main('GET', `${path}?${query}`)));
  }
  expect(pages).toHaveLength(2);
  const occurrences = pages.flatMap(page => page.occurrences);
  expect(occurrences.map(item => item.occurrence)).toEqual(recipe.occurrenceIds);
  expect(new Set(occurrences.map(item => item.occurrence)).size).toBe(recipe.occurrenceIds.length);
  expect(pages.every(page => page.revision === recipe.revision)).toBe(true);
  expect(pages.flatMap(page => page.ingredients).map(item => item.originalText)).toEqual(recipe.ingredientTexts);
  expect(pages.flatMap(page => page.ingredients).every(item => item.amount.numerator === 3 && item.amount.denominator === 1)).toBe(true);
  expect(occurrences.filter(item => item.role === 'step').map(item => item.qualifier?.instructionText))
    .toEqual([{ value: 'Mix the sauce.', language: 'en' }, { value: 'Cook for five minutes.', language: 'en' }]);
  expect(occurrences.filter(item => item.role === 'group').map(item => item.labels[0]?.value)).toEqual(['Sauce', 'Empty garnish']);
  query.set('cursor', first.next!);
  const replay = await answer<Page>(person.main('GET', `${path}?${query}`));
  expect(replay.occurrences).toEqual(pages[1]!.occurrences);
  query.set('servings', '3');
  await answer(person.main('GET', `${path}?${query}`), 400);
  query.delete('servings');
  const cursor = first.next!;
  query.set('cursor', `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`);
  await answer(person.main('GET', `${path}?${query}`), 400);
  for (const servings of ['1.5', '101']) await answer(person.main('GET', `${path}?${acting(person)}&servings=${servings}`), 400);
  {
    const privateWork = name === 'stranger' ? ownerHidden : hidden;
    const hiddenAnswer = await person.main('GET', `/v1/recipes/works/${short(privateWork.work)}?${acting(person)}`);
    const absentAnswer = await person.main('GET', `/v1/recipes/works/00000000-0000-4000-8000-000000000099?${acting(person)}`);
    expect([hiddenAnswer.status, await hiddenAnswer.text()]).toEqual([absentAnswer.status, await absentAnswer.text()]);
    expect(hiddenAnswer.status).toBe(404);
  }
  if (name === 'owner') {
    const preview = await answer<{ revision: string }>(person.main('GET',
      `/v1/compositions/${short(recipe.structure)}/revisions/${short(recipe.draftRevision!)}?${acting(person)}`));
    expect(preview.revision).toBe(recipe.draftRevision);
  }
}
outcomeTest(reading, 'visitor', () => read('visitor'));
outcomeTest(reading, 'stranger', () => read('stranger'));
outcomeTest(reading, 'member', () => read('member'));
outcomeTest(reading, 'owner', () => read('owner'));
outcomeTest(reading, 'moderator', () => read('moderator'));
outcomeTest(reading, 'operator', () => read('operator'));
