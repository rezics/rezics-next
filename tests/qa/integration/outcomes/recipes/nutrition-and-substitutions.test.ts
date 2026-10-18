import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import nutrition from '../../../../../scripts/qa/cases/outcomes/recipes/nutrition-and-substitutions.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import type { PersonaName } from '../../../support/personas.ts';
import { addPrivateRecipeDraft, answer, ownCookProgress, publicDomainFixture,
  publishPublicRecipe, recipePages, short, viewer, type Call } from '../../../support/catalogue-public-domain.ts';
import type { Measure, PublicRecipe } from '../../../fixtures/catalogue-public-domain.ts';

setDefaultTimeout(120_000);
const recording = new OutcomeRecorder(nutrition);
let fixture: Awaited<ReturnType<typeof publicDomainFixture>>;
beforeAll(async () => {
  fixture = await publicDomainFixture('nutrition');
  await recording.prepare();
  const distinct = new Map([fixture.corpus.noNutritionRecipe, ...fixture.corpus.nutritionRecipes].map(item => [item.work, item]));
  for (const recipe of distinct.values()) {
    await publishPublicRecipe(fixture.people, recipe);
    await addPrivateRecipeDraft(fixture.people, recipe);
  }
}, 600_000);
afterAll(async () => {
  try { await recording.publish(); } finally { await fixture?.close(); }
});

async function qualifiedRead(call: Call, name: PersonaName, recipe: PublicRecipe) {
  const person = fixture.people[name];
  const pages = await recipePages(call, person, recipe);
  // Measures repeat on each page; do not sum them once per continuation.
  const expected = recipe.measures.map(item => item.value);
  for (const page of pages) expect(page.measures).toEqual(expected);
  const nutrients = pages[0]!.measures.filter(item => item.kind === 'nutrient');
  if (recipe.nutrition === 'absent') {
    expect(nutrients).toEqual([]);
    expect(expected.filter(item => item.kind === 'nutrient')).toEqual([]);
  } else {
    expect(nutrients.length).toBeGreaterThan(0);
    for (const value of nutrients) {
      expect(value.unit).toBeString();
      expect(value.nutrient).toBeString();
      const source = expected.find(item => item.kind === 'nutrient'
        && item.nutrient === value.nutrient && item.unit === value.unit && item.basis === value.basis);
      expect(source).toBeDefined();
      expect(value).toEqual(source!);
    }
  }
  const occurrences = pages.flatMap(page => page.occurrences);
  for (const ingredient of recipe.ingredients) {
    const shown = occurrences.find(item => item.occurrence === ingredient.occurrence);
    expect(shown).toMatchObject({ role: 'ingredient', qualifier: ingredient.qualifier });
    const relations = recipe.substitutions.filter(item => item.alternative === ingredient.occurrence);
    expect(ingredient.qualifier.substituteFor).toEqual(relations.map(item => item.for));
  }
  for (const alternative of recipe.substitutions) {
    expect(alternative.declaredBy).toBe(recipe.source.author);
    expect(recipe.ingredients.some(item => item.occurrence === alternative.for)).toBe(true);
    // An alternative replaces this occurrence only; a repeated flour use is a distinct target.
    const shown = occurrences.find(item => item.occurrence === alternative.alternative);
    expect(shown?.qualifier).toMatchObject({ substituteFor: [alternative.for] });
  }
  const header = await answer<{ rights: unknown }>(call('GET', viewer(person, `/v1/works/${short(recipe.work)}`)));
  expect(header.rights).toMatchObject({ basis: 'public-domain', source: {
    author: recipe.source.author, observation: recipe.source.observation,
    transcriber: fixture.people[recipe.publisher].actingSubject,
  } });

  const serving = expected.find(item => item.kind === 'servings')!.value;
  const scaled = await recipePages(call, person, recipe, 3);
  const scaledNutrients = scaled[0]!.measures.filter(item => item.kind === 'nutrient');
  expect(scaledNutrients).toHaveLength(nutrients.length);
  for (const source of nutrients) {
    const changed = scaledNutrients.find(item => item.nutrient === source.nutrient
      && item.unit === source.unit && item.basis === source.basis)!;
    expect(changed).toBeDefined();
    const { value: _original, ...meaning } = source;
    expect(changed).toMatchObject(meaning);
    scaledNutrition(changed, source, serving.numerator, serving.denominator);
  }
}

function scaledNutrition(actual: Measure, source: Measure, servingsNumerator: number, servingsDenominator: number) {
  const numerator = source.basis === 'whole-recipe' ? 3 * servingsDenominator : 1;
  const denominator = source.basis === 'whole-recipe' ? servingsNumerator : 1;
  expect(BigInt(actual.value.numerator) * BigInt(source.value.denominator) * BigInt(denominator))
    .toBe(BigInt(source.value.numerator) * BigInt(numerator) * BigInt(actual.value.denominator));
}

async function read(name: PersonaName) {
  const person = fixture.people[name], sample = recording.session(name, person);
  let reads = 0;
  const call: Call = (method, path, body, key, options) => sample(`nutrition-${++reads}`, method, path, body, key, options);
  for (const recipe of [...fixture.corpus.nutritionRecipes, fixture.corpus.noNutritionRecipe])
    await qualifiedRead(call, name, recipe);
  const recipe = fixture.corpus.nutritionRecipes[0]!;
  await ownCookProgress(call, fixture.people, name, recipe);
  // Public reader privileges, including membership/moderation/platform roles, confer no editor mandate.
  if (name !== recipe.publisher) {
    const actor = person.actingSubject ?? fixture.people.owner.actingSubject;
    await answer(call('POST', `/v1/recipes/${short(recipe.structure)}/measures`, {
      expectedHead: recipe.revision, actingSubject: actor,
      yield: { value: { numerator: 1, denominator: 1 }, unitText: 'servings', coverage: 'complete', provenance: 'declared' },
      nutrition: { basis: 'whole-recipe', inputs: [] },
    }, randomUUID()), name === 'visitor' ? 401 : 403);
    await answer(call('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
      actingSubject: actor, expectedWorkHead: recipe.workRevision, expectedMainVersion: recipe.mainVersion,
      structure: recipe.structure, expectedStructureHead: recipe.revision, expectedPublicationHead: null,
      disclosure: 'public', rightsBasis: 'public-domain', sourceObservation: recipe.source.observation,
    }), name === 'visitor' ? 401 : 403);
  }
}
outcomeTest(nutrition, 'visitor', () => read('visitor'), recording);
outcomeTest(nutrition, 'stranger', () => read('stranger'), recording);
outcomeTest(nutrition, 'member', () => read('member'), recording);
outcomeTest(nutrition, 'owner', () => read('owner'), recording);
outcomeTest(nutrition, 'moderator', () => read('moderator'), recording);
outcomeTest(nutrition, 'operator', () => read('operator'), recording);
