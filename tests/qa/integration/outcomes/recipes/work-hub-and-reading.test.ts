import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import hub from '../../../../../scripts/qa/cases/outcomes/recipes/work-hub-and-reading.ts';
import { acting, fixtureAnswer, originalRecipe, short, type RecipeWork } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { launchRecipeSources } from '../../../../../scripts/load/launch-corpus.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let original: RecipeWork;
let imported: RecipeWork;
const source = launchRecipeSources().find(recipe => recipe.pinId === 'boston-cookbook' && recipe.recipeId === 'quick-puff-paste')!;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  original = await originalRecipe(sessions.owner, 'Original sauce hub');
  const work = await fixtureAnswer<{ work: string; workRevision: string; mainVersion: string }>(sessions.owner.main('POST',
    '/v1/works', { profile: 'metadata-only-v1', title: source.title, language: source.language,
      semanticTypes: ['https://schema.org/Recipe'], authoring: 'own-work', actingSubject: sessions.owner.actingSubject }), 201);
  const composition = await fixtureAnswer<{ structure: string; revision: string }>(sessions.owner.main('POST',
    '/v1/compositions', { profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion,
      actingSubject: sessions.owner.actingSubject }), 201);
  imported = { ...work, ...composition, ingredientTexts: [], occurrenceIds: [] };
  const retained = await fixtureAnswer<{ revision: string }>(sessions.owner.main('POST',
    `/v1/recipes/${short(imported.structure)}/file-imports?${acting(sessions.owner)}&expectedHead=${encodeURIComponent(imported.revision)}`, {
      '@context': 'https://schema.org', '@type': 'Recipe', name: source.title, inLanguage: source.language,
      recipeIngredient: source.ingredients,
      recipeInstructions: source.methods.map(text => ({ '@type': 'HowToStep', text, inLanguage: source.language })),
    }), 201);
  imported.revision = retained.revision;
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

  // Private file intake retains the pinned extract, but records unknown rights.
  // It cannot substitute for source-marked platform publication. The imported
  // expression is never published as the importer's original contribution.
  expect(source.language).toBe('en');
  expect(source.ingredients.length).toBeGreaterThan(0);
  const response = await sessions.operator.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: imported.work,
    actingSubject: sessions.operator.actingSubject, expectedWorkHead: imported.workRevision,
    expectedMainVersion: imported.mainVersion, structure: imported.structure,
    expectedStructureHead: imported.revision, expectedPublicationHead: null,
    disclosure: 'public', rightsBasis: 'public-domain',
  });
  const raw = await response.text();
  // The accepted source slice cannot yet be set up: the HTTP schema rejects
  // public-domain before source binding, credit, transcriber or mandate checks.
  expect(response.status, `Source-marked recipe setup unavailable: ${response.status}: ${raw}`).toBe(201);
  const selected = await answer<{ revision: string; ingredients: Array<{ originalText: string }>;
    occurrences: Array<{ qualifier?: { instructionText?: { value: string; language: string } } }> }>(person.main('GET',
    `/v1/recipes/works/${short(imported.work)}?${acting(person)}`));
  expect(selected.revision).toBe(imported.revision);
  expect(selected.ingredients.map(item => item.originalText)).toEqual(source.ingredients.map(text => text.trim()));
  expect(selected.occurrences.flatMap(item => item.qualifier?.instructionText ? [item.qualifier.instructionText] : []))
    .toEqual(source.methods.map(text => ({ value: text.trim(), language: source.language })));
  const sourceCredits = await answer<{ items: Array<{ role: string; agent?: string | null; displayName: string | null }> }>(
    person.main('GET', `/v1/works/${short(imported.work)}/credits?${acting(person)}`));
  expect(sourceCredits.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'author', displayName: 'Fannie Merritt Farmer' }),
    expect.objectContaining({ role: 'transcriber', agent: sessions.owner.actingSubject }),
  ]));
  expect(sourceCredits.items.some(item => item.role === 'author' && item.agent === sessions.owner.actingSubject)).toBe(false);
}
outcomeTest(hub, 'visitor', () => readHub('visitor'));
outcomeTest(hub, 'stranger', () => readHub('stranger'));
outcomeTest(hub, 'member', () => readHub('member'));
outcomeTest(hub, 'owner', () => readHub('owner'));
outcomeTest(hub, 'moderator', () => readHub('moderator'));
outcomeTest(hub, 'operator', () => readHub('operator'));
