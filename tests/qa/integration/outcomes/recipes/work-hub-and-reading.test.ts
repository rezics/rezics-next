import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import hub from '../../../../../scripts/qa/cases/outcomes/recipes/work-hub-and-reading.ts';
import { acting, originalRecipe, short, type RecipeWork } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { launchRecipeSources } from '../../../../../scripts/load/launch-corpus.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let original: RecipeWork;
const source = launchRecipeSources().find(recipe => recipe.pinId === 'boston-cookbook' && recipe.recipeId === 'quick-puff-paste')!;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  original = await originalRecipe(sessions.owner, 'Original sauce hub');
}, 180_000);
afterAll(async () => { await sessions?.close(); });

async function readHub(name: PersonaName) {
  const person = sessions[name], root = `/v1/works/${short(original.work)}`;
  const header = await answer<{ publicationState: string; links: { credits: string } }>(person.main('GET', `${root}?${acting(person)}`));
  expect(header.publicationState).toBe('published');
  expect(header.links.credits).toContain('/credits');
  const credits = await answer<{ items: Array<{ role: string; agent: string | null }> }>(person.main('GET', `${root}/credits?${acting(person)}`));
  expect(credits.items).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject })]));
  const recipe = await answer<{ revision: string; occurrences: unknown[]; ingredients: Array<{ originalText: string }> }>(person.main('GET',
    `/v1/recipes/works/${short(original.work)}?${acting(person)}`));
  expect(recipe.revision).toBe(original.revision);
  expect(recipe.ingredients.map(item => item.originalText)).toEqual(original.ingredientTexts);
  expect(recipe.occurrences).toHaveLength(6);

  // Probe the existing publication owner's missing sourced alternative. This
  // scaffold contains only original text; copied expression is never declared
  // an original contribution just to make the public read fixture available.
  expect(source.language).toBe('en');
  expect(source.ingredients.length).toBeGreaterThan(0);
  const response = await sessions.operator.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: original.work,
    actingSubject: sessions.operator.actingSubject, expectedWorkHead: original.workRevision,
    expectedMainVersion: original.mainVersion, structure: original.structure,
    expectedStructureHead: original.revision, expectedPublicationHead: null,
    disclosure: 'public', rightsBasis: 'public-domain',
  });
  const raw = await response.text();
  // The accepted source slice cannot yet be set up: the HTTP schema rejects
  // public-domain before source binding, credit, transcriber or mandate checks.
  expect(response.status, `Source-marked recipe setup unavailable: ${response.status}: ${raw}`).toBe(201);
}
outcomeTest(hub, 'visitor', () => readHub('visitor'));
outcomeTest(hub, 'stranger', () => readHub('stranger'));
outcomeTest(hub, 'member', () => readHub('member'));
outcomeTest(hub, 'owner', () => readHub('owner'));
outcomeTest(hub, 'moderator', () => readHub('moderator'));
outcomeTest(hub, 'operator', () => readHub('operator'));
