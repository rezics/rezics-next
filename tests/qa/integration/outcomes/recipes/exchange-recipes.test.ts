import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import exchange from '../../../../../scripts/qa/cases/outcomes/recipes/exchange-recipes.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
type Recipe = { work: string; mainVersion: string; structure: string; revision: string; workHead: string };
type Export = { revision: string; recipe: { recipeIngredient: Record<string, unknown>[]; recipeInstructions: unknown[] }; sourceObservations: string[]; residuals: unknown[] };
let source: Recipe;
let retained: Recipe & { observation: string };
let sourceExport: Export;
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
const exportPath = (recipe: Recipe, person: PersonaSession) => `/v1/recipes/${short(recipe.structure)}/exports/schema-org${query(person)}&revision=${encodeURIComponent(recipe.revision)}`;
const importPath = (recipe: Recipe, person: PersonaSession) => `/v1/recipes/${short(recipe.structure)}/file-imports${query(person)}&expectedHead=${encodeURIComponent(recipe.revision)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function destination(person: PersonaSession): Promise<Recipe> {
  const work = await answer<{ work: string; mainVersion: string }>(person.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original recipe exchange fixture', language: 'en',
    semanticTypes: ['https://schema.org/Recipe'], authoring: 'own-work', actingSubject: person.actingSubject,
  }), 201);
  const structure = await answer<{ structure: string; revision: string }>(person.main('POST', '/v1/compositions', {
    profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: person.actingSubject,
  }), 201);
  const head = await answer<{ revision: string }>(person.main('GET', `/v1/works/${short(work.work)}/scalar-value${query(person)}`));
  return { ...work, ...structure, workHead: head.revision };
}
const publish = (recipe: Recipe, person: PersonaSession) => ({
  profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
  actingSubject: person.actingSubject, expectedWorkHead: recipe.workHead, expectedMainVersion: recipe.mainVersion,
  structure: recipe.structure, expectedStructureHead: recipe.revision, expectedPublicationHead: null,
  rightsBasis: 'original-contribution', disclosure: 'public',
});
beforeAll(async () => {
  sessions = await personaSessions('private');
  const owner = sessions.owner;
  source = await destination(owner);
  const path = `/v1/compositions/${short(source.structure)}/changes`;
  const groups = await answer<{ revision: string; occurrences: string[] }>(owner.main('POST', path, {
    profile: 'recipe-composition', expectedHead: source.revision, actingSubject: owner.actingSubject,
    operations: ['Mix', 'Finish'].map(value => ({ op: 'insert', parent: source.structure, position: 'last', role: 'group', label: { value, language: 'en' } })),
  }));
  const changed = await answer<{ revision: string }>(owner.main('POST', path, {
    profile: 'recipe-composition', expectedHead: groups.revision, actingSubject: owner.actingSubject,
    operations: [
      ...[{ numerator: 3, denominator: 2 }, { numerator: 1, denominator: 4 }].map(amount => ({
        op: 'insert', parent: source.structure, position: 'last', role: 'ingredient',
        qualifier: { type: 'ingredient-line', originalText: { value: 'flour', language: 'fr' }, amountLexical: `${amount.numerator}/${amount.denominator}`,
          amount, unitText: 'cup', optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial' },
      })),
      ...['Mix the first portion.', 'Fold in the second portion.'].map((value, index) => ({
        op: 'insert', parent: groups.occurrences[index], position: 'last', role: 'step',
        qualifier: { type: 'recipe-step', instructionText: { value, language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' },
      })),
    ],
  }));
  source.revision = changed.revision;
  await answer(owner.main('POST', '/v1/work-publications', publish(source, owner)), 201);
  sourceExport = await answer(owner.main('GET', exportPath(source, owner)));
  retained = { ...await destination(owner), observation: '' };
  const imported = await answer<{ revision: string; sourceObservation: string }>(owner.main('POST', importPath(retained, owner), sourceExport.recipe), 201);
  retained.revision = imported.revision;
  retained.observation = imported.sourceObservation;
}, 180_000);
afterAll(async () => { await sessions?.close(); });

async function exchangeRecipe(name: PersonaName) {
  const person = sessions[name];
  const publicPage = await answer<{ revision: string; ingredients: { originalText: string }[] }>(person.main('GET', `/v1/recipes/works/${short(source.work)}${query(person)}`));
  expect(publicPage.revision).toBe(source.revision);
  expect(publicPage.ingredients.map(item => item.originalText)).toEqual(['flour', 'flour']);
  const credits = await answer<{ items: { role: string; agent: string }[] }>(person.main('GET', `/v1/works/${short(source.work)}/credits${query(person)}`));
  expect(credits.items.filter(item => item.role === 'author').map(item => item.agent)).toEqual([sessions.owner.actingSubject!]);
  if (name === 'visitor') {
    await answer(person.main('GET', exportPath(source, sessions.owner)), 401);
    await answer(person.main('POST', importPath(source, sessions.owner), sourceExport.recipe), 401);
    await answer(person.main('POST', `/v1/recipes/${short(source.structure)}/imports`, {
      actingSubject: sessions.owner.actingSubject, expectedHead: source.revision, sourceObservation: retained.observation,
    }), 401);
    return;
  }
  const exported = await answer<Export>(person.main('GET', exportPath(source, person)));
  expect(exported.revision).toBe(source.revision);
  expect(exported.recipe).toEqual(sourceExport.recipe);
  expect(exported.recipe.recipeIngredient.map(item => item.value)).toEqual(['3/2', '1/4']);
  expect(exported.recipe.recipeIngredient.map(item => item.inLanguage)).toEqual(['fr', 'fr']);
  expect(exported.residuals).toHaveLength(2);
  if (name !== 'owner') {
    await answer(person.main('POST', importPath(source, person), exported.recipe), 403);
    const observationRequest = { actingSubject: person.actingSubject, expectedHead: source.revision, sourceObservation: retained.observation };
    const hidden = await person.main('POST', `/v1/recipes/${short(source.structure)}/imports`, observationRequest);
    const absent = await person.main('POST', `/v1/recipes/${short(source.structure)}/imports`, { ...observationRequest, sourceObservation: `https://rezics.com/id/${randomUUID()}` });
    expect(hidden.status).toBe(404);
    expect([hidden.status, await hidden.text()]).toEqual([absent.status, await absent.text()]);
  }
  if (name === 'moderator' || name === 'operator') return;
  const own = await destination(person);
  const key = randomUUID();
  const imported = await answer<{ revision: string; sourceObservation: string; replayed: boolean }>(person.main('POST', importPath(own, person), exported.recipe, key), 201);
  expect(imported.replayed).toBe(false);
  expect(await answer(person.main('POST', importPath(own, person), exported.recipe, key), 200))
    .toMatchObject({ ...imported, replayed: true });
  await answer(person.main('POST', importPath(own, person), exported.recipe), 409);
  const importedRecipe = { ...own, revision: imported.revision };
  const roundTrip = await answer<Export>(person.main('GET', exportPath(importedRecipe, person)));
  expect(roundTrip.recipe).toEqual(exported.recipe);
  expect(roundTrip.residuals.map(item => (item as { text: string }).text)).toEqual(['flour', 'flour']);
  expect(roundTrip.sourceObservations).toEqual([imported.sourceObservation]);
  type Page = { revision: string; ingredients: { originalText: string; amount: { numerator: number; denominator: number } }[]; occurrences: { occurrence: string; role: string; sourceKey?: string }[] };
  const page = await answer<Page>(person.main('GET', `/v1/recipes/works/${short(own.work)}${query(person)}`));
  expect(page.revision).toBe(imported.revision);
  expect(page.ingredients.map(item => item.amount)).toEqual([{ numerator: 3, denominator: 2 }, { numerator: 1, denominator: 4 }]);
  const lines = page.occurrences.filter(item => item.role === 'ingredient');
  expect(lines).toHaveLength(2);
  expect(new Set(lines.map(item => item.occurrence)).size).toBe(2);
  expect(page.occurrences.every(item => item.sourceKey?.startsWith(imported.sourceObservation))).toBe(true);
  // File possession carries no publication grant or claim of original authorship.
  expect(await answer<{ code: string }>(person.main('POST', '/v1/work-publications', publish(importedRecipe, person)), 403))
    .toMatchObject({ code: 'authority_denied' });
  await answer(sessions.visitor.main('GET', `/v1/recipes/works/${short(own.work)}`), 404);
  const second = await destination(person);
  const observationCommand = { actingSubject: person.actingSubject, expectedHead: second.revision,
    sourceObservation: imported.sourceObservation };
  const observationKey = randomUUID();
  const importedObservation = await answer<{ revision: string }>(person.main('POST', `/v1/recipes/${short(second.structure)}/imports`, observationCommand, observationKey));
  expect(await answer(person.main('POST', `/v1/recipes/${short(second.structure)}/imports`, observationCommand, observationKey)))
    .toMatchObject({ revision: importedObservation.revision });
  const observationExport = await answer<Export>(person.main('GET', exportPath({ ...second, revision: importedObservation.revision }, person)));
  expect(observationExport.recipe).toEqual(roundTrip.recipe);
  expect(observationExport.sourceObservations).toEqual([imported.sourceObservation]);
}
outcomeTest(exchange, 'visitor', () => exchangeRecipe('visitor'));
outcomeTest(exchange, 'stranger', () => exchangeRecipe('stranger'));
outcomeTest(exchange, 'member', () => exchangeRecipe('member'));
outcomeTest(exchange, 'owner', () => exchangeRecipe('owner'));
outcomeTest(exchange, 'moderator', () => exchangeRecipe('moderator'));
outcomeTest(exchange, 'operator', () => exchangeRecipe('operator'));
