import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import type { AuditFilePin } from '../fixtures/audit-corpus-contract.ts';
import { publicDomainBaseline, privateRecipeText, assertPublicDomainOriginalWorks, assertPublicDomainNativeCreation, type PublicDomainCorpus,
  type PublicRecipe, type RecipePage, type SourceQuote } from '../fixtures/catalogue-public-domain.ts';
import { grantPersonaFixtureAuthority } from './persona-fixture-authority.ts';
import { assertAuditExecution } from './audit-execution.ts';
import { restorePersonaRealms, type PersonaSession, type PersonaSessions } from './personas.ts';

export const short = (id: string) => id.slice(-36);
export const viewer = (person: PersonaSession, path: string) => person.actingSubject
  ? `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ actingSubject: person.actingSubject })}` : path;
export type Call = PersonaSession['main'];
export async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

function localFile(path: string): string {
  const file = resolve(path), part = relative(realpathSync('.'), realpathSync(file));
  if (isAbsolute(path) || part.startsWith('..') || !/^(?:\.temp|tests\/fixtures)\//.test(part))
    throw new Error('Public corpus files must stay in this worktree .temp or tests/fixtures');
  return file;
}
function sourceQuote(quote: SourceQuote): void {
  const bytes = readFileSync(localFile(quote.file));
  if (!/^[a-f0-9]{64}$/.test(quote.sha256)
    || createHash('sha256').update(bytes).digest('hex') !== quote.sha256 || !quote.exact.trim())
    throw new Error(`Frozen public corpus source digest/quote is invalid: ${quote.file}`);
  // Gutenberg JSON pins retain the text as a JSON string; other pins may be raw text.
  let text = bytes.toString('utf8');
  try { text = JSON.stringify(JSON.parse(text)); } catch { /* Raw retained source text. */ }
  if (!text.includes(JSON.stringify(quote.exact).slice(1, -1)) && !bytes.toString('utf8').includes(quote.exact))
    throw new Error(`Public corpus quote is absent from frozen source: ${quote.file}`);
}

function admissionJson(pin: AuditFilePin, label: string): unknown {
  if (!pin || typeof pin.file !== 'string' || typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256))
    throw new Error(`TEST PREMISE: ${label} needs an existing producer file/digest pin`);
  try {
    const bytes = readFileSync(localFile(pin.file));
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('digest differs');
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`TEST PREMISE: ${label} pinned evidence is invalid: ${pin.file}`, { cause: error });
  }
}

/** Fixture admission only; genuine source, rights, structure and publication checks still follow. */
export function assertPublicDomainWorkAdmission(corpus: Pick<PublicDomainCorpus, 'originals' | 'importedWorks'>,
  targets: ReadonlyArray<Pick<PublicRecipe, 'work' | 'creationReceipt'> & { mainVersion?: string }>): void {
  assertPublicDomainOriginalWorks(corpus.importedWorks, admissionJson(corpus.originals, 'original 113 association ledger'));
  for (const target of targets) {
    if (corpus.importedWorks.includes(target.work) && target.creationReceipt === undefined) continue;
    const pin = target.creationReceipt;
    if (!pin) throw new Error(`TEST PREMISE: additional native Work ${target.work} is missing its creation receipt`);
    assertPublicDomainNativeCreation(target, admissionJson({ file: pin.path, sha256: pin.sha256 }, 'native creation receipt'));
  }
}

export function loadPublicDomainCorpus(): PublicDomainCorpus {
  const path = '.temp/goal/public-domain-corpus.json';
  if (!existsSync(path)) throw new Error(`TEST PREMISE: missing ${path}; prepare one isolated command-created corpus `
    + 'with explicit product/test revision pins, retain a consistent owner backup and reviewed source quotes within 600 seconds. '
    + 'No product assertion has been reached. Do not use the shared dev stack or the retained private recipe.');
  const corpus = JSON.parse(readFileSync(localFile(path), 'utf8')) as PublicDomainCorpus;
  // This legacy field records the historical baseline, not the repaired product under test.
  assertAuditExecution(corpus, { productBaseline: corpus.productRevision });
  if (corpus.profile !== 'catalogue-public-domain-corpus-v1' || corpus.productRevision !== publicDomainBaseline
    || !corpus.preparationQaRun || !Number.isFinite(corpus.preparationMs)
    || corpus.preparationMs <= 0 || corpus.preparationMs > 600_000)
    throw new Error('TEST PREMISE: public corpus baseline/preparation evidence is missing or outside 600 seconds');
  localFile(corpus.backup);
  if (corpus.importedWorks.length !== 113 || new Set(corpus.importedWorks).size !== 113)
    throw new Error('TEST PREMISE: retain all 113 original imported Work identities');
  const recipes = [corpus.richRecipe, corpus.noNutritionRecipe, ...corpus.nutritionRecipes];
  assertPublicDomainWorkAdmission(corpus, [...recipes, corpus.book]);
  for (const item of recipes) {
    if (!item.source.author || !item.source.observation
      || !item.ingredients.length || !item.steps.length)
      throw new Error('TEST PREMISE: real recipes need source attribution and nonempty structure');
    const serving = item.measures.find(measure => measure.value.kind === 'servings')?.value.value;
    if (!serving || serving.numerator <= 0 || serving.denominator <= 0
      || new Set(item.order).size !== item.order.length
      || [...item.ingredients, ...item.steps].some(entry => !item.order.includes(entry.occurrence)))
      throw new Error('TEST PREMISE: recipes need positive source servings and a complete distinct occurrence receipt');
    for (const citation of [...item.ingredients, ...item.steps, ...item.measures, ...item.substitutions]) sourceQuote(citation.evidence);
    if (item.nutrition === 'absent' && item.measures.some(measure => measure.value.kind === 'nutrient'))
      throw new Error('TEST PREMISE: do not invent nutrition absent from the source');
    if (item.nutrition === 'stated' && !item.measures.some(measure => measure.value.kind === 'nutrient'))
      throw new Error('TEST PREMISE: a stated-nutrition source must contain reviewed nutrient values');
  }
  const rich = corpus.richRecipe;
  const names = rich.ingredients.map(item => item.qualifier.name);
  if (!names.some((name, index) => name && names.indexOf(name) !== index)
    || !rich.steps.some(item => item.qualifier.usesIngredient.length)
    || !rich.ingredients.some(item => item.qualifier.amount && item.qualifier.amount.denominator > 1
      && item.qualifier.scaling === 'linear')
    || !rich.measures.some(item => item.value.kind === 'servings')
    || !rich.measures.some(item => item.value.kind === 'cooking-duration'))
    throw new Error('TEST PREMISE: rich real recipe needs duplicate uses, fractional amounts, linked steps, servings and duration');
  if (corpus.noNutritionRecipe.nutrition !== 'absent') throw new Error('TEST PREMISE: missing no-nutrition source control');
  const nutrients = corpus.nutritionRecipes.flatMap(item => item.measures.filter(measure => measure.value.kind === 'nutrient'));
  if (nutrients.some(item => !item.value.unit || !item.value.nutrient || !item.value.basis
    || !item.value.coverage || !item.value.provenance))
    throw new Error('TEST PREMISE: every source nutrient needs explicit units, basis, coverage and provenance');
  for (const [field, values] of [['basis', ['per-serving', 'whole-recipe']],
    ['coverage', ['complete', 'partial', 'unknown']], ['provenance', ['declared', 'source-stated', 'computed']]] as const) {
    if (values.some(value => !nutrients.some(item => item.value[field] === value)))
      throw new Error(`TEST PREMISE: retained nutrition evidence must exercise ${field}: ${values.join(', ')}`);
  }
  if (!corpus.nutritionRecipes.some(item => item.substitutions.length))
    throw new Error('TEST PREMISE: missing author-declared exact substitute occurrence evidence');
  const book = corpus.book;
  if (book.releases.length < 2 || book.chapters.length < 2
    || book.chapters.some(chapter => chapter.bodyText.length < 200
      || !chapter.body.exact.replace(/\s+/gu, ' ').includes(chapter.bodyText.replace(/\s+/gu, ' ').trim())))
    throw new Error('TEST PREMISE: real Book needs genuine releases and meaningful chapter bodies');
  for (const evidence of [book.description.evidence, book.author.evidence,
    ...book.releases.map(item => item.evidence), ...book.chapters.map(item => item.body)]) sourceQuote(evidence);
  return corpus;
}

/** Restores only. A failed/missing prerequisite never triggers a fresh import. */
export async function publicDomainFixture(selection: string) {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with an isolated QA stack');
  const corpus = loadPublicDomainCorpus();
  const target = `public-domain-${selection}-${randomUUID().slice(0, 8)}`;
  let people: PersonaSessions | undefined;
  let copyEnvironment: Record<string, string> = {};
  const driver = createCorpusBackupDriver({ sourceRunId: Bun.env.REZICS_QA_RUN_ID,
    directory: resolve('.temp/goal/public-domain-copies'), resumeSource: false,
    async quiesce() { throw new Error('Public domain outcome consumers restore the retained backup; they never rebuild it'); },
    async smokeRead(input) {
      const environment = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
        REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      copyEnvironment = environment;
      const previous = new Map(Object.keys(environment).map(key => [key, Bun.env[key]]));
      Object.assign(Bun.env, environment);
      try {
        [people] = await restorePersonaRealms([corpus.personas]);
        if (!people) throw new Error('Retained public corpus personas are missing');
        await answer(people.visitor.main('GET', `/v1/works/${short(corpus.book.work)}`));
        input.signal.throwIfAborted();
        return () => people!.close();
      } catch (error) { await people?.close(); throw error; }
      finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
        }
      }
    },
  });
  await driver.restore(corpus.backup, target, AbortSignal.timeout(600_000));
  const preparation = driver.preparation(target);
  expect(preparation?.totalMs).toBeLessThanOrEqual(600_000);
  const previous = new Map(Object.keys(copyEnvironment).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, copyEnvironment);
  return { corpus, people: people!, preparation, close: async () => {
    try { await driver.stop(target); }
    finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
      }
    }
  } };
}

/** Setup asserts the grant, truthful publication and anonymous non-null receipt
 * before any test.failing body can classify an outcome failure. */
export async function publishPublicRecipe(people: PersonaSessions, recipe: PublicRecipe): Promise<void> {
  const publisher = people[recipe.publisher];
  await grantPersonaFixtureAuthority(publisher, [{ scope: `work:publish:${recipe.work}`, action: 'work.publish' }]);
  const receipt = await answer<{ publicationDecision: string }>(publisher.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
    actingSubject: publisher.actingSubject, expectedWorkHead: recipe.workRevision,
    expectedMainVersion: recipe.mainVersion, structure: recipe.structure, expectedStructureHead: recipe.revision,
    expectedPublicationHead: null, disclosure: 'public', rightsBasis: 'public-domain', sourceObservation: recipe.source.observation,
  }), 201);
  expect(receipt.publicationDecision).toBeString();
  const page = await answer<RecipePage | null>(people.visitor.main('GET', `/v1/recipes/works/${short(recipe.work)}`));
  expect(page, 'TEST PREMISE: successful publication must have an anonymous non-null recipe').not.toBeNull();
  expect(page?.revision).toBe(recipe.revision);
  expect(page?.structure).toBe(recipe.structure);
}

export async function addPrivateRecipeDraft(people: PersonaSessions, recipe: PublicRecipe): Promise<void> {
  await answer(people[recipe.publisher].main('POST', `/v1/compositions/${short(recipe.structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: recipe.revision, actingSubject: people[recipe.publisher].actingSubject,
    operations: [{ op: 'insert', parent: recipe.structure, position: 'last', role: 'ingredient', qualifier: {
      type: 'ingredient-line', originalText: { value: privateRecipeText, language: 'en' },
      optional: false, scaling: 'not-scalable', substituteFor: [], parseStatus: 'unparsed',
    } }],
  }));
}

export async function recipePages(call: Call, person: PersonaSession, recipe: PublicRecipe, servings?: number) {
  const pages: RecipePage[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams();
    if (cursor) query.set('cursor', cursor);
    else if (servings !== undefined) query.set('servings', String(servings));
    const page = await answer<RecipePage>(call('GET', viewer(person, `/v1/recipes/works/${short(recipe.work)}?${query}`)));
    expect(page).toMatchObject({ profile: 'recipe-work-page-v1', structure: recipe.structure, revision: recipe.revision });
    expect(page.occurrences.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(page)).not.toContain(privateRecipeText);
    pages.push(page);
    cursor = page.next;
    if (cursor) { expect(seen.has(cursor), 'Recipe continuation must advance').toBe(false); seen.add(cursor); }
    expect(pages.length).toBeLessThanOrEqual(Math.ceil(recipe.order.length / 100) + 1);
  } while (cursor);
  expect(pages.flatMap(page => page.occurrences.map(item => item.occurrence))).toEqual(recipe.order);
  return pages;
}

/** Cook's durable API state is whole-Work standing. Step/timer UI behavior is a
 * separate browser obligation; an API standing receipt does not prove that UI. */
export async function ownCookProgress(call: Call, people: PersonaSessions, name: keyof Pick<PersonaSessions,
  'visitor' | 'stranger' | 'member' | 'owner' | 'moderator' | 'operator'>, recipe: PublicRecipe) {
  const person = people[name], path = `/v1/works/${short(recipe.work)}/progress`;
  const other = name === 'owner' ? people.stranger : people.owner;
  if (name === 'visitor') {
    await answer(call('PUT', path, { actingSubject: other.actingSubject, expectedVersion: 0, standing: 'started' }), 401);
    return;
  }
  type Standing = { work: string; parts: false; standing: string; version: number; replayed?: boolean };
  const read = await answer<Standing>(call('GET', viewer(person, path)));
  expect(read).toMatchObject({ work: recipe.work, parts: false });
  const key = randomUUID();
  const body = { actingSubject: person.actingSubject, expectedVersion: read.version, standing: 'started' };
  const saved = await answer<Standing>(call('PUT', path, body, key));
  expect(saved).toMatchObject({ work: recipe.work, standing: 'started', version: read.version + 1 });
  expect(await answer(call('PUT', path, body, key))).toMatchObject({ ...saved, replayed: true });
  await answer(call('PUT', path, { ...body, standing: 'completed' }), 409);
  const refreshed = await call('GET', viewer(person, path));
  expect(refreshed.headers.get('cache-control')).toBe('private, no-store');
  expect(await answer(Promise.resolve(refreshed))).toMatchObject({ standing: 'started', version: saved.version });
  await answer(call('GET', `${path}?${new URLSearchParams({ actingSubject: other.actingSubject! })}`), 403);
  await answer(call('PUT', path, { ...body, actingSubject: other.actingSubject }), 403);
}
