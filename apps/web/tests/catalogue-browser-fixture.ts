import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { LaunchBooksCorpus, LaunchRecipesCorpus } from '../../../scripts/load/launch-corpus-types.ts';
import { browserMainApi } from '../features/api/browser.ts';
import type { ReportInput, ReportSelection } from '../features/safety/report.ts';
import type { RecipeWorkPage } from '../features/work-page/types.ts';
import { credentials } from './g-855-library.ts';

/**
 * Pending browser contract, C13-C15/C21-C22/C26-C31; no cell is proved by this declaration.
 *
 * Prove both e2e files through goalctl test, on one isolated restored corpus. API
 * outcome authors own preparation using seedImportedCatalogue/catalogueFixture,
 * prepareLaunchBooksCorpus/prepareLaunchRecipesCorpus, the retained audit import
 * receipts and grantFixtureAuthority. This module only consumes their receipts;
 * it never builds, publishes, restores, grants authority or substitutes demo data.
 * The launch Book's six genuine editions and the 30 retained recipes remain intact.
 * Rich public nutrition, chapters and owned report objects are additional fixture
 * prerequisites; the historical launch corpus does not establish those outcomes.
 *
 * Place the receipt mapping at .temp/audit-remediation-20261019/browser-<runId>.json.
 * This is test input, not a new product API or corpus lifecycle. Missing inputs are
 * setup errors. Reuse one consistent backup; preparation + restore <= 600 seconds.
 * Never point this mapping at the shared audit account or a shared development stack.
 *
 * UI details proposed for review before implementation:
 * - one [data-subject-header][data-resource][data-semantic-type] per main, containing
 *   H1, Primary actions, Reactions and the button "More actions for <title>";
 * - [data-primary-content] precedes [data-community-content]; sparse pages omit empty
 *   sections, rather than rendering placeholders above useful information;
 * - growing regions expose [data-catalogue-item][data-resource][data-occurrence],
 *   readable labels/counts and "Load more"; occurrence is the list identity;
 * - main's final contentinfo is named "Sources and licenses". Its list items carry
 *   data-source-key and name each component to which the deduplicated obligation applies;
 * - report entry is an overflow menuitem, never a resting visible report button/link;
 *   the owning menu offers "Report", then a dialog "Choose what to report" with
 *   human-readable radio choices and "Continue"/"Cancel". No internal ID entry;
 * - nutrition rows identify their evidence with data-source-key; evidence links
 *   remain in the bottom source collection, including after serving changes;
 * - retry regions keep data-resource/data-semantic-type and offer "Retry". Faults
 *   abort actual browser GETs or return an unavailable error; successful bodies
 *   and source data always come from Main.
 * These markers bind assertions to identities; all tests also assert visible content,
 * task effects, actual API answers or decoded image bytes.
 *
 * Personas: public detail reads use visitor; edition/progress and login return use
 * the isolated web member (stranger to imported objects); report receipt tests use
 * only that member's owned fixture. Six-persona API qualification stays with the
 * API outcome authors/G-2768. Registry enrollment and proof status are not edited here.
 */
export const headerFamilies = ['book', 'recipe', 'work', 'profile', 'person',
  'organization', 'concept', 'release', 'thread', 'realm'] as const;
export type HeaderFamily = typeof headerFamilies[number];

export interface Subject {
  id: string;
  href: string;
  title: string;
  semanticType: string;
  usefulText: string;
  primaryAction: string;
  reaction: string;
  tabs: string[];
}

export interface PublicImage {
  subject: Subject;
  kind: 'cover' | 'portrait';
  alt: string;
  representation: string;
  use: string | null;
  mediaType: string;
  selection: string;
  deliveryHref: string;
  sha256: string;
  width: number;
  height: number;
  /** Frozen authorized image input; bytes must equal the served representation. */
  retained: { path: string; sha256: string };
}

export interface SourceObligation {
  key: string;
  source: { label: string; href: string };
  license: { label: string; href: string };
  evidence: Array<{ label: string; href: string }>;
  notice: string;
  components: string[];
}

export interface CatalogueList {
  kind: 'classifications' | 'cast' | 'relations' | 'releases';
  subject: Subject;
  region: string;
  /** More than the owning API's normal first page; do not lower limit for this proof. */
  items: Array<{ id: string; occurrence: string; label: string; href: string }>;
}

export interface RecoveryCase {
  kind: 'header' | 'name' | 'page' | 'recipe' | 'chapter';
  subject: Subject;
  region: string;
  /** Exact GET pathname under /api/main; trigger must actually issue this read. */
  apiPath: string;
  trigger: { role: 'button' | 'link' | 'tab'; name: string };
  recoveredText: string;
  unavailableText: string;
}

export interface ReportTarget {
  owner: 'subject' | 'post' | 'reply';
  label: string;
  target: ReportInput['target'];
  selection?: ReportSelection;
  excerpt: string;
}

export interface CatalogueBrowserFixture {
  runId: string;
  baselineRevision: string;
  preparationMs: number;
  backup: { path: string; sha256: string };
  /** Original retained receipt identities, not a newly generated synthetic corpus. */
  imported: { receipt: { path: string; sha256: string }; identities: string[] };
  snapshots: Array<{ path: string; sha256: string }>;
  books: LaunchBooksCorpus;
  recipes: LaunchRecipesCorpus;
  headers: Record<HeaderFamily, { rich: Subject; sparse: Subject }>;
  images: PublicImage[];
  sourcePage: {
    subject: Subject;
    obligations: SourceObligation[];
    creators: Array<{ name: string; role: 'Author' | 'Translator' | 'Performer'; href: string }>;
    /** Private raw import paths/identities must never appear in public HTML or links. */
    privateEvidence: string[];
  };
  cast: { work: Subject; character: Subject; role: string; inverseRegion: string };
  lists: CatalogueList[];
  book: {
    subject: Subject;
    summary: string;
    author: string;
    language: string;
    editions: Array<{ release: string; revision: string; label: string; language: string; publisher: string; year: number }>;
    chapters: Array<{ id: string; occurrence: string; revision: string; title: string; text: string; href: string }>;
  };
  recipe: {
    subject: Subject;
    recipeId: string;
    structure: string;
    revision: string;
    publicationDecision: string;
    servings: number;
    scaledServings: number;
    /** Truthful original/source rights basis, recorded by the public publication command. */
    publicationReceipt: { path: string; sha256: string };
    ingredients: Array<{ occurrence: string; line: string; scaledLine: string;
      amount: { numerator: number; denominator: number }; unit: string }>;
    steps: Array<{ occurrence: string; text: string }>;
    durations: string[];
    nutrition: Array<{ nutrient: string; label: string; value: { numerator: number; denominator: number };
      valueText: string; scaledValue: { numerator: number; denominator: number }; scaledText: string;
      unit: string; unitText: string; sourceKey: string; basis: 'per-serving' | 'whole-recipe';
      coverage: 'complete' | 'partial' | 'unknown'; provenance: 'declared' | 'source-stated' | 'computed'; evidence: string }>;
    substitutions: Array<{ occurrence: string; substituteFor: string[]; line: string; author: string }>;
    /** A genuine source with no declared nutrition; no values may be invented. */
    withoutNutrition: Subject;
    /** Known Recipe with an admitted public header and a genuinely absent public body. */
    withoutBody: Subject;
  };
  collections: Array<{ role: 'Reading lists' | 'Curations' | 'Series' | 'Collections';
    subject: Subject; collection: Subject; members: Array<{ occurrence: string; id: string; title: string; href: string }> }>;
  recovery: RecoveryCase[];
  coverage: Array<{ subject: Subject; state: 'source-empty' | 'acquisition-failed' | 'unmapped' |
    'pending-adoption' | 'adopted' | 'unknown'; label: string; knownText: string; privateEvidence: string[] }>;
  reporting: {
    subject: Subject;
    actingSubject: string;
    /** Evidence the isolated member created these objects through normal commands. */
    ownershipReceipt: { path: string; sha256: string };
    targets: ReportTarget[];
    post: { id: string; text: string };
    reply: { id: string; text: string };
    secondReply: { id: string; text: string };
  };
}

function temporaryFile(path: string): string {
  const root = realpathSync(resolve('.temp'));
  const file = realpathSync(resolve(path));
  const tail = relative(root, file);
  assert(tail && !tail.startsWith('..') && !isAbsolute(tail), 'Fixture inputs must live in this worktree .temp');
  return file;
}

function retained(input: { path: string; sha256: string }): Buffer {
  assert.match(input.sha256, /^[a-f0-9]{64}$/, 'Missing frozen fixture digest');
  const bytes = readFileSync(temporaryFile(input.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256, `Fixture changed: ${input.path}`);
  return bytes;
}

export async function catalogueBrowserFixture(): Promise<CatalogueBrowserFixture> {
  const runId = process.env.REZICS_QA_RUN_ID;
  assert(runId, 'Catalogue browser acceptance requires isolated goalctl browser QA');
  assert.match(runId, /^[a-z0-9][a-z0-9-]*$/);
  const file = resolve('.temp/audit-remediation-20261019', `browser-${runId}.json`);
  let fixture: CatalogueBrowserFixture;
  try { fixture = JSON.parse(readFileSync(file, 'utf8')) as CatalogueBrowserFixture; }
  catch (cause) { throw new Error(`Missing prepared catalogue browser corpus: ${file}; API fixture owners must prepare and restore it before prove`, { cause }); }
  assert.equal(fixture.runId, runId);
  assert.match(fixture.baselineRevision, /^[a-f0-9]{40}$/);
  assert(fixture.preparationMs > 0 && fixture.preparationMs <= 600_000, 'Combined preparation/restore exceeds 600 seconds');
  // Stream the frozen backup: reading a complete database archive into memory
  // would make the browser's fixture validation itself exceed its resource budget.
  assert.match(fixture.backup.sha256, /^[a-f0-9]{64}$/);
  const backupDigest = createHash('sha256');
  for await (const bytes of createReadStream(temporaryFile(fixture.backup.path))) backupDigest.update(bytes);
  assert.equal(backupDigest.digest('hex'), fixture.backup.sha256, 'The consistent corpus backup changed');
  assert(fixture.snapshots.length > 0, 'Retain approved original source snapshots');
  fixture.snapshots.forEach(retained);
  const imported = JSON.parse(retained(fixture.imported.receipt).toString()) as { native: Record<string, { id: string }> };
  assert.equal(fixture.imported.identities.length, 113, 'Retain all 113 audited import identities');
  assert.equal(new Set(fixture.imported.identities).size, 113);
  const nativeIds = new Set(Object.values(imported.native).map(item => item.id));
  for (const id of fixture.imported.identities) assert(nativeIds.has(id), `Original import identity missing from receipt: ${id}`);
  assert.equal(fixture.books.recipe, 'launch-books-v2');
  assert.equal(fixture.books.editions.length, 6, 'Preserve all genuine edition evidence');
  assert.equal(fixture.recipes.recipe, 'launch-real-recipes-v2');
  assert.equal(fixture.recipes.records.length, 30);
  const sourceRecipe = fixture.recipes.records.find(item => item.recipeId === fixture.recipe.recipeId);
  assert(sourceRecipe, 'Rich Recipe must identify a retained real recipe');
  assert.equal(sourceRecipe.work, fixture.recipe.subject.id);
  assert.equal(sourceRecipe.structure, fixture.recipe.structure);
  assert.equal(sourceRecipe.revision, fixture.recipe.revision);
  assert.equal(fixture.books.work, fixture.book.subject.id);
  assert(fixture.recipe.ingredients.length >= 2 && fixture.recipe.steps.length >= 2, 'A rich public Recipe is required');
  assert(fixture.recipe.servings > 0 && fixture.recipe.scaledServings !== fixture.recipe.servings);
  assert(fixture.recipe.nutrition.length >= 2 && fixture.recipe.substitutions.length > 0, 'Source-backed nutrition and declared substitutions are prerequisites');
  const publication = JSON.parse(retained(fixture.recipe.publicationReceipt).toString()) as Record<string, unknown>;
  assert.equal(publication.work, fixture.recipe.subject.id);
  assert.equal(publication.publicationDecision, fixture.recipe.publicationDecision);
  assert.equal(publication.structureRevision, fixture.recipe.revision);
  assert.equal(publication.profile, 'work-structure-publication-v1');
  assert.equal(publication.operation, 'publish');
  assert(fixture.book.chapters.length >= 2 && fixture.book.editions.length >= 2, 'A public real Book with readable chapters and selectable editions is required');
  for (const edition of fixture.book.editions)
    assert(fixture.books.editions.some(item => item.release === edition.release && item.revision === edition.revision
      && item.publisher === edition.publisher && item.publicationYear === edition.year), 'Edition must retain its genuine source revision');
  for (const family of headerFamilies) for (const density of ['rich', 'sparse'] as const) {
    const subject = fixture.headers[family][density];
    assert(subject.title && subject.usefulText && subject.primaryAction && subject.reaction, `${family}/${density} lacks a usable header fixture`);
    assert.match(subject.id, /^https:\/\/rezics\.com\/id\/[a-f0-9-]{36}$/);
    assert(subject.href.startsWith('/en/'));
  }
  for (const kind of ['classifications', 'cast', 'relations', 'releases'])
    assert(fixture.lists.some(item => item.kind === kind && item.items.length > 20), `Missing real multi-page ${kind} fixture`);
  for (const family of ['book', 'recipe', 'work', 'person'])
    assert(fixture.images.some(image => image.subject.id === fixture.headers[family as HeaderFamily].rich.id), `Missing real ${family} image`);
  for (const image of fixture.images) {
    assert(image.width > 1 && image.height > 1);
    assert.equal(image.retained.sha256, image.sha256);
    retained(image.retained);
  }
  assert(new Set(fixture.images.filter(image => image.kind === 'cover' && !['https://schema.org/Book', 'https://schema.org/Recipe']
    .includes(image.subject.semanticType)).map(image => image.subject.semanticType)).size >= 2,
  'Ordinary non-book covers need two media types, independently of showcase art');
  for (const role of ['Reading lists', 'Curations', 'Series', 'Collections'])
    assert(fixture.collections.some(item => item.role === role), `Missing ${role} semantic control`);
  for (const kind of ['header', 'name', 'page', 'recipe', 'chapter'])
    assert(fixture.recovery.some(item => item.kind === kind), `Missing ${kind} recovery premise`);
  for (const state of ['source-empty', 'acquisition-failed', 'unmapped', 'pending-adoption', 'adopted', 'unknown'])
    assert(fixture.coverage.some(item => item.state === state), `Missing ${state} source coverage control`);
  const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  assert(privatePath, 'Missing isolated web-auth fixture');
  temporaryFile(privatePath);
  const reader = credentials();
  assert.equal(fixture.reporting.actingSubject, reader.actingSubject);
  const owned = JSON.parse(retained(fixture.reporting.ownershipReceipt).toString()) as { actingSubject: string; resources: string[] };
  assert.equal(owned.actingSubject, reader.actingSubject);
  for (const id of [fixture.reporting.subject.id, fixture.reporting.post.id, fixture.reporting.reply.id, fixture.reporting.secondReply.id])
    assert(owned.resources.includes(id), 'Reports may only target the isolated member\'s command-created fixture');
  for (const component of ['cover', 'synopsis', 'body', 'media_use'])
    assert(fixture.reporting.targets.some(target => target.selection?.component === component), `Missing exact ${component} report target`);
  for (const owner of ['subject', 'post', 'reply'])
    assert(fixture.reporting.targets.some(target => target.owner === owner && !target.selection), `Missing whole-${owner} report target`);
  return fixture;
}

export const short = (iri: string) => iri.slice(-36);
export const header = (page: Page) => page.locator('main [data-subject-header]');

/** User-visible text in the actual content document, excluding metadata strings. */
export function documentText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { text?: unknown; doc?: unknown; content?: unknown };
  return [typeof node.text === 'string' ? node.text : '', documentText(node.doc),
    ...(Array.isArray(node.content) ? node.content.map(documentText) : [])].filter(Boolean).join(' ');
}

export function documentMediaUses(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const node = value as { attrs?: { mediaUseId?: unknown }; doc?: unknown; content?: unknown };
  return [typeof node.attrs?.mediaUseId === 'string' ? [node.attrs.mediaUseId] : [], documentMediaUses(node.doc),
    ...(Array.isArray(node.content) ? node.content.map(documentMediaUses) : [])].flat();
}

/** Real Eden client over the browser context's cookies and real BFF, without source stubs. */
export function catalogueApi(page: Page) {
  const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await page.request.fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(request.method !== 'GET' && request.method !== 'HEAD' ? { data: Buffer.from(await request.arrayBuffer()) } : {}),
    });
    return new Response(await response.body(), { status: response.status(), headers: response.headers() });
  }, { preconnect: fetch.preconnect });
  return browserMainApi(new URL(page.url()).origin, { cache: 'no-store', fetcher });
}

export async function apiData<T>(answer: Promise<{ data: T | null; error: unknown; status: number }>, step: string): Promise<NonNullable<T>> {
  const result = await answer;
  expect(result.error, `${step}: HTTP ${result.status}`).toBeNull();
  expect(result.status, step).toBe(200);
  expect(result.data, `${step}: null is not a successful corpus prerequisite`).not.toBeNull();
  return result.data!;
}

export async function publicSubject(page: Page, subject: Subject) {
  const response = await page.goto(subject.href);
  expect(response?.status(), subject.href).toBe(200);
  await expect(header(page)).toHaveAttribute('data-resource', subject.id);
  await expect(header(page)).toHaveAttribute('data-semantic-type', subject.semanticType);
  await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(subject.title);
  const projection = await apiData(catalogueApi(page).v1.resources({ resource: short(subject.id) }).page.get(), 'public entity page');
  expect(projection.summary.reference).toBe(subject.id);
  expect(projection.summary.status).toBe('available');
  expect(projection.registry.type).toBe(subject.semanticType);
  return projection;
}

export async function recipePages(page: Page, fixture: CatalogueBrowserFixture, servings?: number): Promise<RecipeWorkPage[]> {
  const pages: RecipeWorkPage[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const data = await apiData(catalogueApi(page).v1.recipes.works({ id: short(fixture.recipe.subject.id) }).get({
      query: cursor ? { cursor } : { servings },
    }), 'public Recipe');
    expect(data.structure).toBe(fixture.recipe.structure);
    expect(data.revision).toBe(fixture.recipe.revision);
    pages.push(data);
    cursor = data.next;
    if (cursor) {
      expect(cursors.has(cursor), 'Recipe cursor advances').toBe(false);
      cursors.add(cursor);
    }
    expect(pages.length, 'Recipe traversal is bounded').toBeLessThanOrEqual(100);
  } while (cursor);
  return pages;
}

/** Reach through actual Tab order; focus() would conceal a keyboard trap. */
export async function tabTo(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  for (let step = 0; step < 120; step++) {
    if (await control.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Control is absent from bounded keyboard order: ${await control.getAttribute('aria-label')}`);
}

/** Refuse every message endpoint, including accidental follow-up or correspondence. */
export async function forbidMessages(context: BrowserContext) {
  const attempts: string[] = [];
  await context.route(/\/(?:api\/main\/)?v1\/.*(?:messages|correspondence)(?:[/?]|$)/, async route => {
    if (route.request().method() === 'GET') { await route.fallback(); return; }
    attempts.push(new URL(route.request().url()).pathname);
    await route.abort('blockedbyclient');
  });
  return attempts;
}
