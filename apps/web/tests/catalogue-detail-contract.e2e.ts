import { createHash } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { credentials } from './g-855-library.ts';
import {
  apiData, catalogueApi, catalogueBrowserFixture, documentText, forbidMessages, header, headerFamilies,
  publicSubject, recipePages, short, type CatalogueBrowserFixture, type CatalogueList,
  type SourceObligation, type Subject,
} from './catalogue-browser-fixture.ts';

// Pending real-browser acceptance. Authoring/type checks prove no browser or persona cell.
// C28 is the real-Book half of the accepted C27 criteria; it has no separate staged row.
let corpus: CatalogueBrowserFixture;
let messageAttempts: string[] = [];
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => { corpus = await catalogueBrowserFixture(); });
test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  messageAttempts = await forbidMessages(context);
});
test.afterEach(() => { expect(messageAttempts, 'No user messages may be sent').toEqual([]); });

const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const visibleReport = (page: Page) => page.locator('main').getByRole('button', { name: /^Report(?:\s|$)/ })
  .or(page.locator('main').getByRole('link', { name: /^Report(?:\s|$)/ }));

async function before(first: Locator, second: Locator, reason: string) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a, reason).not.toBeNull();
  expect(b, reason).not.toBeNull();
  expect(a!.y + a!.height, reason).toBeLessThanOrEqual(b!.y + 2);
}

for (const viewport of viewports) for (const family of headerFamilies) for (const density of ['rich', 'sparse'] as const) {
  test(`C22 C26 / visitor / ${family} ${density} header at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const subject = corpus.headers[family][density];
    await publicSubject(page, subject);
    const top = header(page);
    await expect(top).toHaveCount(1);
    await expect(page.locator('main').getByRole('heading', { level: 1 })).toHaveCount(1);
    const primary = top.getByRole('group', { name: 'Primary actions', exact: true });
    const reactions = top.getByRole('group', { name: 'Reactions', exact: true });
    const more = top.getByRole('button', { name: `More actions for ${subject.title}`, exact: true });
    await expect(primary.getByRole('button', { name: subject.primaryAction, exact: true })
      .or(primary.getByRole('link', { name: subject.primaryAction, exact: true }))).toBeVisible();
    await expect(reactions.getByRole('button', { name: subject.reaction, exact: true })).toBeVisible();
    await expect(more).toBeVisible();
    const actions = [primary, reactions, more];
    const boxes = await Promise.all(actions.map(action => action.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    expect(boxes[2]!.x, 'subject overflow is beside reactions at the right').toBeGreaterThanOrEqual(boxes[1]!.x + boxes[1]!.width);
    expect(Math.abs(boxes[2]!.y - boxes[1]!.y), 'reaction and overflow stay on the same row').toBeLessThan(16);
    expect(await primary.evaluate((element, reaction) => Boolean(element.compareDocumentPosition(reaction as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      await reactions.elementHandle()), 'primary actions precede light reactions in reading order').toBe(true);
    await expect(visibleReport(page)).toHaveCount(0);
    const useful = page.locator('main [data-primary-content]');
    await expect(useful).toContainText(subject.usefulText);
    const community = page.locator('main [data-community-content]');
    if (await community.count()) await before(useful, community, 'useful typed content precedes community material');
    if (density === 'sparse') {
      const empty = page.locator('main section').filter({ hasText: /^(No (reviews|ratings|discussions|releases|relations)|Nothing here yet)[.!]?$/ });
      await expect(empty).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    if (family === 'thread') await expect(page.locator('main [data-subject-header] h1')).toHaveText(subject.title);
  });
}

async function sourceFooter(page: Page, subject: Subject, obligations: SourceObligation[]) {
  const main = page.locator('main');
  const footer = main.getByRole('contentinfo', { name: 'Sources and licenses', exact: true });
  await expect(footer).toHaveCount(1);
  await expect(footer).toBeVisible();
  expect(await footer.evaluate(element => {
    const main = element.closest('main')!;
    return [...main.querySelectorAll('section, [role="region"], [data-primary-content], [data-community-content]')]
      .filter(candidate => candidate !== element && !element.contains(candidate) && !candidate.contains(element))
      .filter(candidate => (candidate as HTMLElement).offsetHeight > 0)
      .every(candidate => Boolean(candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), `${subject.title}: source collection follows every visible content section`).toBe(true);
  for (const item of obligations) {
    const row = footer.locator('[data-source-key]').filter({ has: page.locator(`a[href="${item.source.href}"]`) });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-source-key', item.key);
    await expect(row.getByRole('link', { name: item.source.label, exact: true })).toHaveAttribute('href', item.source.href);
    await expect(row.getByRole('link', { name: item.license.label, exact: true })).toHaveAttribute('href', item.license.href);
    await expect(row).toContainText(item.notice);
    for (const component of item.components) await expect(row).toContainText(component);
    for (const evidence of item.evidence)
      await expect(row.getByRole('link', { name: evidence.label, exact: true })).toHaveAttribute('href', evidence.href);
    for (const href of [item.source.href, ...item.evidence.map(evidence => evidence.href)]) {
      await expect(main.locator(`a[href="${href}"]`)).toHaveCount(1);
    }
  }
  // Different sources can share one license. Each obligation retains its mapping,
  // and every link/notice occurrence outside the owning footer is forbidden.
  const outside = await main.evaluate((element, links) => [...element.querySelectorAll('a')]
    .filter(link => links.includes(link.getAttribute('href') ?? ''))
    .filter(link => !link.closest('[role="contentinfo"], footer')).map(link => link.textContent),
  obligations.flatMap(item => [item.source.href, item.license.href, ...item.evidence.map(evidence => evidence.href)]));
  expect(outside).toEqual([]);
}

for (const viewport of viewports) test(`C21 / visitor / source obligations and creator credits at ${viewport.width}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const { subject, obligations, creators, privateEvidence } = corpus.sourcePage;
  expect(obligations.length, 'multiple real source obligations are required').toBeGreaterThanOrEqual(2);
  expect(obligations.some(item => item.components.includes('Cover'))).toBe(true);
  expect(obligations.some(item => item.components.includes('Synopsis'))).toBe(true);
  await publicSubject(page, subject);
  for (const tab of [null, ...subject.tabs]) {
    if (tab) await page.getByRole('tab', { name: tab, exact: true }).click();
    await sourceFooter(page, subject, obligations);
    const credits = page.getByRole('region', { name: 'Credits', exact: true });
    for (const creator of creators) {
      await expect(credits).toContainText(creator.role);
      await expect(credits.getByRole('link', { name: creator.name, exact: true })).toHaveAttribute('href', creator.href);
    }
    expect(new Set(creators.map(creator => creator.role))).toEqual(new Set(['Author', 'Translator', 'Performer']));
    const html = await page.locator('main').innerHTML();
    for (const secret of privateEvidence) expect(html).not.toContain(secret);
  }
});

test('C13 / visitor / ordinary Book Recipe non-book covers and Person portrait decode from retained bytes', async ({ page }) => {
  for (const image of corpus.images) {
    const projection = await publicSubject(page, image.subject);
    if (projection.work) {
      expect(projection.work.cover).toMatchObject({ kind: 'image', selection: image.selection,
        url: image.deliveryHref, width: image.width, height: image.height });
    }
    const metadata = await apiData(catalogueApi(page).v1.media.representations({ representation: image.representation })
      .get({ query: image.use ? { use: image.use } : {} }), 'public image representation');
    expect(metadata).toMatchObject({ representation: image.representation, use: image.use,
      sha256: image.sha256, mediaType: image.mediaType, width: image.width, height: image.height });
    const img = header(page).getByRole('img', { name: image.alt, exact: true });
    await expect(img).toBeVisible();
    const decoded = await img.evaluate(async node => {
      if (!(node instanceof HTMLImageElement)) throw new Error('Catalogue image must render an actual image');
      await node.decode();
      return { src: node.currentSrc, width: node.naturalWidth, height: node.naturalHeight };
    });
    expect(decoded.width).toBe(image.width);
    expect(decoded.height).toBe(image.height);
    expect(new URL(decoded.src).pathname).toBe(new URL(image.deliveryHref, page.url()).pathname);
    const actual = await page.request.get(decoded.src);
    expect(actual.status()).toBe(200);
    expect(actual.headers()['content-type']).toMatch(/^image\//);
    expect(createHash('sha256').update(await actual.body()).digest('hex')).toBe(image.sha256);
    await expect(page.locator('[data-showcase-hero], [data-showcase-logo]')).toHaveCount(0);
  }
});

test('C14 / visitor / cast and inverse navigation do not require a wiki Zone', async ({ page }) => {
  const { work, character, role, inverseRegion } = corpus.cast;
  await publicSubject(page, work);
  await expect(page.locator('main a[href*="/wiki"]')).toHaveCount(0);
  const cast = page.getByRole('region', { name: 'Cast', exact: true });
  const row = cast.getByRole('listitem').filter({ hasText: character.title });
  await expect(row).toContainText(role);
  await row.getByRole('link', { name: character.title, exact: true }).click();
  await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(character.title);
  await expect(header(page)).toHaveAttribute('data-resource', character.id);
  const relations = await apiData(catalogueApi(page).v1.resources({ resource: short(character.id) }).relations.get(), 'inverse cast relation');
  expect(relations.items.some(item => item.counterparts.some(counterpart => counterpart.reference === work.id))).toBe(true);
  await page.getByRole('region', { name: inverseRegion, exact: true }).getByRole('link', { name: work.title, exact: true }).click();
  await expect(header(page)).toHaveAttribute('data-resource', work.id);
});

async function readList(page: Page, list: CatalogueList) {
  const api = catalogueApi(page);
  const id = short(list.subject.id);
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    if (list.kind === 'classifications') {
      const data = await apiData(api.v1.works({ id }).classifications.get({ query: { scope: 'global', cursor } }), 'classifications');
      ids.push(...data.items.map(item => item.concept));
      cursor = data.nextCursor ?? undefined;
    } else if (list.kind === 'releases') {
      const data = await apiData(api.v1.works({ id }).releases.get({ query: { cursor } }), 'releases');
      ids.push(...data.items.map(item => item.id));
      cursor = data.nextCursor ?? undefined;
    } else {
      const data = await apiData(api.v1.resources({ resource: id }).relations.get({ query: { cursor } }), list.kind);
      ids.push(...data.items.flatMap(item => item.counterparts.map(counterpart => counterpart.reference)));
      cursor = data.next ?? undefined;
    }
    if (cursor) {
      expect(cursors.has(cursor), `${list.kind} cursor advances`).toBe(false);
      cursors.add(cursor);
    }
    pageCount++;
    expect(pageCount).toBeLessThanOrEqual(100);
  } while (cursor);
  expect(pageCount, 'actual normal API continuation, without a lowered page bound').toBeGreaterThan(1);
  expect(ids).toEqual(list.items.map(item => item.id));
}

test('C15 / visitor / every classification cast relation and release is reachable in stable order', async ({ page }) => {
  for (const list of corpus.lists) {
    await publicSubject(page, list.subject);
    await readList(page, list);
    const region = page.getByRole('region', { name: list.region, exact: true });
    const rows = region.locator('[data-catalogue-item]');
    const more = region.getByRole('button', { name: 'Load more', exact: true });
    const initial = await rows.count();
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(list.items.length);
    await expect(region).toContainText(new RegExp(`${initial}\\s+(?:of|loaded)`));
    for (let step = 0; await rows.count() < list.items.length; step++) {
      expect(step).toBeLessThan(100);
      await expect(more).toBeEnabled();
      const previous = await rows.count();
      await more.click();
      await expect.poll(() => rows.count()).toBeGreaterThan(previous);
      expect(await rows.count()).toBeLessThanOrEqual(list.items.length);
    }
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-resource')))).toEqual(list.items.map(item => item.id));
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-occurrence')))).toEqual(list.items.map(item => item.occurrence));
    for (const [index, item] of list.items.entries()) {
      await expect(rows.nth(index)).toContainText(item.label);
      await expect(rows.nth(index).getByRole('link', { name: item.label, exact: true })).toHaveAttribute('href', item.href);
    }
    await expect(region).toContainText(new RegExp(`${list.items.length}\\s+(?:of\\s+${list.items.length}|total)`));
    await expect(more).toHaveCount(0);
    await publicSubject(page, list.subject);
    const firstRows = region.locator('[data-catalogue-item]');
    expect(await firstRows.evaluateAll(elements => elements.map(element => element.getAttribute('data-resource'))))
      .toEqual(list.items.slice(0, initial).map(item => item.id));
    for (const [index, item] of list.items.slice(0, initial).entries()) await expect(firstRows.nth(index)).toContainText(item.label);
    await region.getByRole('link', { name: list.items[0]!.label, exact: true }).click();
    await expect(header(page)).toHaveAttribute('data-resource', list.items[0]!.id);
  }
});

test('C27 / visitor / the retained public Recipe scales exact ingredients and completes Cook steps', async ({ page }) => {
  const recipe = corpus.recipe;
  const record = corpus.recipes.records.find(item => item.recipeId === recipe.recipeId)!;
  await publicSubject(page, recipe.subject);
  const work = await apiData(catalogueApi(page).v1.works({ id: short(recipe.subject.id) }).get(), 'public Recipe header');
  expect(work.publicationState).toBe('published');
  expect(work.types).toContain('https://schema.org/Recipe');
  const pages = await recipePages(page, corpus);
  expect(pages.flatMap(item => item.ingredients).map(item => item.originalText)).toEqual(record.sourceIngredients);
  expect(pages.flatMap(item => item.ingredients).map(item => item.line)).toEqual(recipe.ingredients.map(item => item.line));
  const region = page.getByRole('region', { name: 'Recipe', exact: true });
  await expect(region.locator('[data-ingredient]')).toHaveText(recipe.ingredients.map(item => item.line));
  await expect(region.locator('[data-step-text]')).toHaveText(record.sourceMethods);
  expect(recipe.steps.map(item => item.text)).toEqual(record.sourceMethods);
  for (const duration of recipe.durations) await expect(region).toContainText(duration);
  const servings = region.getByRole('spinbutton', { name: 'Servings', exact: true });
  await expect(servings).toHaveValue(String(recipe.servings));
  await servings.fill(String(recipe.scaledServings));
  await servings.press('Enter');
  const scaled = await recipePages(page, corpus, recipe.scaledServings);
  for (const [index, ingredient] of scaled.flatMap(item => item.ingredients).entries()) {
    const original = recipe.ingredients[index]!;
    expect(ingredient.occurrence).toBe(original.occurrence);
    expect(ingredient.line).toBe(original.scaledLine);
    expect(ingredient.amount).toBeDefined();
    const factor = BigInt(recipe.scaledServings);
    expect(BigInt(ingredient.amount!.numerator) * BigInt(original.amount.denominator) * BigInt(recipe.servings))
      .toBe(BigInt(original.amount.numerator) * BigInt(ingredient.amount!.denominator) * factor);
    expect(ingredient.unitText).toBe(original.unit);
  }
  await expect(region.locator('[data-ingredient]')).toHaveText(recipe.ingredients.map(item => item.scaledLine));
  await header(page).getByRole('button', { name: 'Cook', exact: true }).click();
  const cook = page.getByRole('dialog', { name: 'Cook', exact: true });
  await expect(cook).toHaveAttribute('data-resource', recipe.subject.id);
  await expect(cook).toHaveAttribute('data-revision', recipe.revision);
  for (const [index, step] of recipe.steps.entries()) {
    await expect(cook).toContainText(step.text);
    await expect(cook).toContainText(`Step ${index + 1} of ${recipe.steps.length}`);
    await cook.getByRole('button', { name: index === recipe.steps.length - 1 ? 'Finish cooking' : 'Next step', exact: true }).click();
  }
  await expect(cook.getByRole('status')).toHaveText('Cooking complete');
  await cook.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(header(page)).toHaveAttribute('data-resource', recipe.subject.id);
  await expect(region.locator('[data-ingredient]')).toHaveText(recipe.ingredients.map(item => item.scaledLine));
});

test('C28 / isolated reader / genuine edition choice and chapter resume survive a return', async ({ page }) => {
  const book = corpus.book;
  const reader = credentials();
  await signInAtAccounts(page, book.subject.href, reader.member);
  const main = catalogueApi(page);
  const query = { actingSubject: reader.actingSubject };
  const work = await apiData(main.v1.works({ id: short(book.subject.id) }).get({ query }), 'real Book');
  expect(work.description?.value).toBe(book.summary);
  expect(work.selectedLanguage).toBe(book.language);
  await expect(page.locator('[data-primary-content]')).toContainText(book.summary);
  await expect(page.getByRole('region', { name: 'Credits', exact: true })).toContainText(book.author);
  const choice = book.editions[1]!;
  expect(corpus.books.editions.some(item => item.release === choice.release && item.publisher === choice.publisher && item.publicationYear === choice.year)).toBe(true);
  const availability = page.getByRole('region', { name: 'Your edition and availability', exact: true });
  await availability.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: choice.language, exact: true }).click();
  await availability.getByRole('combobox', { name: 'Edition', exact: true }).click();
  const option = page.getByRole('option', { name: choice.label, exact: true });
  await expect(option).toContainText(choice.publisher);
  await expect(option).toContainText(String(choice.year));
  await option.click();
  await availability.getByRole('button', { name: 'Save choice', exact: true }).click();
  await expect(availability.getByRole('status')).toHaveText('Saved.');
  const preference = await apiData(main.v1.me['edition-preferences']({ work: short(book.subject.id) }).get({ query }), 'saved exact edition');
  expect(preference).toMatchObject({ work: book.subject.id, language: choice.language,
    edition: { kind: 'release', resource: choice.release, revision: choice.revision } });
  await header(page).getByRole('link', { name: 'Read', exact: true }).click();
  const chapter = book.chapters[0]!;
  const next = book.chapters[1]!;
  const content = page.getByRole('article');
  await expect(content).toContainText(chapter.text);
  await page.getByRole('link', { name: 'Next chapter', exact: true }).click();
  await expect(content).toContainText(next.text);
  await expect(content).toHaveAttribute('data-content-revision', next.revision);
  const apiChapter = await apiData(catalogueApi(page).v1.chapters({ id: short(next.id) }).get({ query }), 'public chapter');
  expect(apiChapter).toMatchObject({ profile: 'work-chapter-v1', work: book.subject.id,
    occurrence: next.occurrence, selectedRevision: next.revision });
  expect(apiChapter.content.reference.revisionId).toBe(next.revision);
  expect(documentText(apiChapter.content.body)).toContain(next.text);
  // A new document and API read distinguish durable progress from local screen state.
  await page.goto(book.subject.href);
  await page.reload();
  await expect(availability.getByRole('combobox', { name: 'Edition', exact: true })).toContainText(choice.publisher);
  const state = await apiData(catalogueApi(page).v1.works({ id: short(book.subject.id) })['reader-state'].get({ query }), 'persisted reader return');
  expect(state.progress).toMatchObject({ occurrence: next.occurrence, selectedRevision: next.revision });
  await header(page).getByRole('link', { name: 'Continue reading', exact: true }).click();
  await expect(content).toContainText(next.text);
  await expect(content).toHaveAttribute('data-content-revision', next.revision);
  await expect(page).toHaveURL(new URL(next.href, page.url()).href);
});

test('C29 / visitor / reading lists curations genuine series and unknown collections preserve their roles and occurrences', async ({ page }) => {
  for (const collection of corpus.collections) {
    await publicSubject(page, collection.subject);
    const relations = await apiData(catalogueApi(page).v1.resources({ resource: short(collection.subject.id) }).relations.get(), 'collection roles');
    expect(relations.items.some(item => item.counterparts.some(other => other.reference === collection.collection.id))).toBe(true);
    const region = page.getByRole('region', { name: collection.role, exact: true });
    await region.getByRole('link', { name: collection.collection.title, exact: true }).click();
    await expect(header(page)).toHaveAttribute('data-resource', collection.collection.id);
    const members = page.getByRole('region', { name: 'Members', exact: true }).getByRole('listitem');
    expect(await members.evaluateAll(rows => rows.map(row => row.getAttribute('data-occurrence')))).toEqual(collection.members.map(item => item.occurrence));
    await expect(members).toHaveText(collection.members.map(item => item.title));
    for (const [index, item] of collection.members.entries())
      await expect(members.nth(index).getByRole('link', { name: item.title, exact: true })).toHaveAttribute('href', item.href);
    if (collection.role !== 'Series') await expect(page.getByRole('heading', { name: /Franchises|Series/, exact: true })).toHaveCount(0);
  }
  const repeated = corpus.collections.find(collection => new Set(collection.members.map(item => item.id)).size < collection.members.length);
  expect(repeated, 'A repeated member control is required; resource deduplication must not erase ordered occurrences').toBeDefined();
});

test('C30 / visitor / declared nutrition exact substitutions and unknown coverage remain truthful', async ({ page }) => {
  const recipe = corpus.recipe;
  await publicSubject(page, recipe.subject);
  const pages = await recipePages(page, corpus);
  const measures = pages[0]!.measures.filter(item => item.kind === 'nutrient');
  expect(measures).toHaveLength(recipe.nutrition.length);
  const nutrition = page.getByRole('region', { name: 'Nutrition', exact: true });
  for (const expected of recipe.nutrition) {
    expect(measures).toContainEqual(expect.objectContaining({ kind: 'nutrient', nutrient: expected.nutrient,
      value: expected.value, unit: expected.unit, basis: expected.basis, coverage: expected.coverage,
      provenance: expected.provenance, evidence: expected.evidence }));
    const row = nutrition.getByRole('row').filter({ hasText: expected.label });
    await expect(row).toContainText(expected.valueText);
    await expect(row).toContainText(expected.unitText);
    await expect(row).toHaveAttribute('data-source-key', expected.sourceKey);
    await expect(row).toContainText(expected.basis === 'per-serving' ? 'Per serving' : 'Whole recipe');
    await expect(row).toContainText(expected.coverage);
    await expect(row).toContainText(expected.provenance);
    const source = page.getByRole('contentinfo', { name: 'Sources and licenses', exact: true })
      .locator(`[data-source-key="${expected.sourceKey}"]`);
    await expect(source).toContainText('Nutrition');
    await expect(source.locator(`a[href="${expected.evidence}"]`)).toHaveCount(1);
    await expect(nutrition.locator(`a[href="${expected.evidence}"]`)).toHaveCount(0);
  }
  expect(new Set(recipe.nutrition.map(item => item.coverage)).size).toBeGreaterThanOrEqual(2);
  const occurrences = pages.flatMap(item => item.occurrences);
  const substitutions = page.getByRole('region', { name: 'Author-declared substitutions', exact: true });
  for (const substitution of recipe.substitutions) {
    const occurrence = occurrences.find(item => item.occurrence === substitution.occurrence);
    expect(occurrence?.qualifier).toMatchObject({ type: 'ingredient-line', substituteFor: substitution.substituteFor });
    const row = substitutions.getByRole('listitem').filter({ hasText: substitution.line });
    await expect(row).toContainText(substitution.author);
    expect(await row.locator('a[data-occurrence]').evaluateAll(links => links.map(link => link.getAttribute('data-occurrence'))))
      .toEqual(substitution.substituteFor);
  }
  await page.getByRole('spinbutton', { name: 'Servings', exact: true }).fill(String(recipe.scaledServings));
  await page.getByRole('spinbutton', { name: 'Servings', exact: true }).press('Enter');
  const scaled = (await recipePages(page, corpus, recipe.scaledServings))[0]!.measures.filter(item => item.kind === 'nutrient');
  for (const nutrient of recipe.nutrition) {
    const measure = scaled.find(item => item.nutrient === nutrient.nutrient)!;
    expect(measure).toMatchObject({ value: nutrient.scaledValue, unit: nutrient.unit,
      basis: nutrient.basis, coverage: nutrient.coverage, provenance: nutrient.provenance, evidence: nutrient.evidence });
    const base = BigInt(nutrient.value.numerator) * BigInt(nutrient.scaledValue.denominator);
    const changed = BigInt(nutrient.scaledValue.numerator) * BigInt(nutrient.value.denominator);
    expect(changed * BigInt(nutrient.basis === 'per-serving' ? 1 : recipe.servings))
      .toBe(base * BigInt(nutrient.basis === 'per-serving' ? 1 : recipe.scaledServings));
    const row = nutrition.getByRole('row').filter({ hasText: nutrient.label });
    await expect(row).toContainText(nutrient.scaledText);
    await expect(row).toContainText(nutrient.unitText);
    await expect(row).toHaveAttribute('data-source-key', nutrient.sourceKey);
  }
  await publicSubject(page, recipe.withoutNutrition);
  const absent = await apiData(catalogueApi(page).v1.recipes.works({ id: short(recipe.withoutNutrition.id) }).get(), 'Recipe without declared nutrition');
  expect(absent.measures.filter(item => item.kind === 'nutrient')).toEqual([]);
  await expect(page.getByRole('region', { name: 'Nutrition', exact: true })).toContainText('Nutrition not provided');
  await expect(page.locator('main')).not.toContainText(/healthy|healthier|low[- ]fat|zero calories/i);
});

test('C31 / visitor / a null public Recipe body keeps Recipe identity and gives a useful Cook explanation', async ({ page }) => {
  const subject = corpus.recipe.withoutBody;
  await publicSubject(page, subject);
  const result = await catalogueApi(page).v1.recipes.works({ id: short(subject.id) }).get();
  expect(result.status).toBe(200);
  expect(result.error).toBeNull();
  expect(result.data).toBeNull();
  await expect(header(page)).toHaveAttribute('data-semantic-type', 'https://schema.org/Recipe');
  await expect(page.getByRole('button', { name: /Want to read/ })).toHaveCount(0);
  await expect(header(page).getByRole('button', { name: 'Cook', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Recipe', exact: true })).toContainText('Cooking instructions are not available');
});

for (const kind of ['header', 'name', 'page', 'recipe', 'chapter'] as const) for (const transport of ['network', 'unavailable'] as const) {
  test(`C31 / visitor / ${kind} ${transport} failure retries the same object and task`, async ({ page }) => {
    const fault = corpus.recovery.find(item => item.kind === kind)!;
    await publicSubject(page, fault.subject);
    let fail = true;
    let aborted = 0;
    let recovered = 0;
    await page.route(url => url.pathname === fault.apiPath, async route => {
      expect(route.request().method(), 'fault injection applies only to reads').toBe('GET');
      if (fail) {
        aborted++;
        if (transport === 'network') await route.abort('failed');
        else await route.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ error: 'work_read_unavailable', message: 'Temporarily unavailable' }) });
      }
      else { recovered++; await route.continue(); }
    });
    await page.getByRole(fault.trigger.role, { name: fault.trigger.name, exact: true }).click();
    const region = page.getByRole('region', { name: fault.region, exact: true });
    await expect(region.getByRole('alert')).toContainText(fault.unavailableText);
    expect(aborted, 'the actual failing API read must be observed; SSR-only faults need an owner-provided fault seam').toBeGreaterThan(0);
    await expect(header(page)).toHaveAttribute('data-resource', fault.subject.id);
    await expect(header(page)).toHaveAttribute('data-semantic-type', fault.subject.semanticType);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(fault.subject.title);
    await expect(region).not.toContainText(/Not found|Unnamed|No ingredients|No chapters/i);
    const retry = region.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeEnabled();
    if (fault.subject.semanticType === 'https://schema.org/Recipe') {
      await expect(header(page).getByRole('button', { name: 'Cook', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: /Want to read/ })).toHaveCount(0);
    }
    fail = false;
    await retry.click();
    await expect(region).toContainText(fault.recoveredText);
    await expect(region.getByRole('alert')).toHaveCount(0);
    expect(recovered).toBeGreaterThan(0);
    expect(aborted, 'automatic retries remain bounded').toBeLessThanOrEqual(3);
    await expect(header(page)).toHaveAttribute('data-resource', fault.subject.id);
    await expect(header(page)).toHaveAttribute('data-semantic-type', fault.subject.semanticType);
    if (fault.subject.semanticType === 'https://schema.org/Recipe') {
      const cook = header(page).getByRole('button', { name: 'Cook', exact: true });
      await expect(cook).toBeEnabled();
      await cook.click();
      await expect(page.getByRole('dialog', { name: 'Cook', exact: true })).toContainText(corpus.recipe.steps[0]!.text);
    }
  });
}

test('C31 / visitor / public source coverage distinguishes empty failed unmapped pending adopted and unknown', async ({ page }) => {
  const labels: string[] = [];
  for (const sample of corpus.coverage) {
    await publicSubject(page, sample.subject);
    const coverage = page.getByRole('region', { name: 'Source coverage', exact: true });
    await expect(coverage).toHaveAttribute('data-coverage', sample.state);
    await expect(coverage).toContainText(sample.label);
    await expect(page.locator('[data-primary-content]')).toContainText(sample.knownText);
    labels.push(await coverage.innerText());
    for (const secret of sample.privateEvidence) expect(await page.locator('main').innerHTML()).not.toContain(secret);
    if (sample.state !== 'source-empty') await expect(coverage).not.toContainText('No source data');
  }
  expect(new Set(labels).size).toBe(6);
});
