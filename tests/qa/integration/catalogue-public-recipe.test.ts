import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { personaNames } from '../support/personas.ts';
import { addPrivateRecipeDraft, answer, ownCookProgress, publicDomainFixture,
  publishPublicRecipe, recipePages, short, viewer } from '../support/catalogue-public-domain.ts';
import type { Rational } from '../fixtures/catalogue-public-domain.ts';

setDefaultTimeout(120_000);
let fixture: Awaited<ReturnType<typeof publicDomainFixture>>;
beforeAll(async () => {
  fixture = await publicDomainFixture('recipe');
  await publishPublicRecipe(fixture.people, fixture.corpus.richRecipe);
  await addPrivateRecipeDraft(fixture.people, fixture.corpus.richRecipe);
}, 600_000);
afterAll(async () => { await fixture?.close(); });

function sameQuantity(actual: Rational | undefined, original: Rational, numerator = 1, denominator = 1) {
  expect(actual).toBeDefined();
  // Cross multiplication is an independent oracle for exact values, including unreduced fractions.
  expect(BigInt(actual!.numerator) * BigInt(original.denominator) * BigInt(denominator))
    .toBe(BigInt(original.numerator) * BigInt(numerator) * BigInt(actual!.denominator));
}

for (const name of personaNames) test.failing(`C27 public real Recipe / ${name}: ordered cooking, exact scaling and own return`, async () => {
  const { corpus, people } = fixture, recipe = corpus.richRecipe, person = people[name];
  const header = await answer<{ id: string; publicationState: string; rights: unknown }>(person.main('GET',
    viewer(person, `/v1/works/${short(recipe.work)}`)));
  expect(header).toMatchObject({ id: recipe.work, publicationState: 'published',
    rights: { basis: 'public-domain', source: { ...recipe.source,
      transcriber: people[recipe.publisher].actingSubject } } });
  const basePages = await recipePages(person.main, person, recipe);
  const base = basePages.flatMap(page => page.ingredients);
  const occurrences = basePages.flatMap(page => page.occurrences);
  expect(base.map(item => item.originalText)).toEqual(recipe.ingredients.map(item => item.qualifier.originalText.value));
  for (const line of recipe.ingredients) {
    const occurrence = occurrences.find(item => item.occurrence === line.occurrence);
    expect(occurrence).toMatchObject({ parent: line.parent, role: 'ingredient', qualifier: line.qualifier });
    const shown = base.find(item => item.occurrence === line.occurrence)!;
    if (line.qualifier.amount) sameQuantity(shown.amount, line.qualifier.amount);
    expect(shown.unitText).toBe(line.qualifier.unitText);
  }
  for (const step of recipe.steps) expect(occurrences.find(item => item.occurrence === step.occurrence))
    .toMatchObject({ parent: step.parent, role: 'step', qualifier: step.qualifier });
  expect(basePages[0]!.measures).toEqual(recipe.measures.map(item => item.value));
  const servings = recipe.measures.find(item => item.value.kind === 'servings')!.value.value;
  const scaledPages = await recipePages(person.main, person, recipe, 3);
  const scaled = scaledPages.flatMap(page => page.ingredients);
  expect(scaled.map(item => item.occurrence)).toEqual(base.map(item => item.occurrence));
  for (const line of recipe.ingredients) {
    const shown = scaled.find(item => item.occurrence === line.occurrence)!;
    const scalable = line.qualifier.scaling === 'linear' && line.qualifier.parseStatus !== 'unparsed';
    if (line.qualifier.amount) sameQuantity(shown.amount, line.qualifier.amount,
      scalable ? 3 * servings.denominator : 1, scalable ? servings.numerator : 1);
    if (line.qualifier.amountUpper) sameQuantity(shown.amountUpper, line.qualifier.amountUpper,
      scalable ? 3 * servings.denominator : 1, scalable ? servings.numerator : 1);
    expect(shown.originalText).toBe(line.qualifier.originalText.value);
    expect(shown.unitText).toBe(line.qualifier.unitText);
    if (!line.qualifier.amount) expect(shown.amount).toBeUndefined();
  }
  // Reopening the public URL still selects the published receipt after scaling and a private edit.
  expect((await recipePages(person.main, person, recipe))[0]!.revision).toBe(recipe.revision);
  await ownCookProgress(person.main, people, name, recipe);
});
