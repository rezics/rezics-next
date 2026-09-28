import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApi, mainApiWithToken } from '../api/main.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { chapterVariant } from './content-api.ts';
import { canonicalLanguage, type ClassificationPage, type ContentsItem, type ContentsPage, type ContentVariantPage, directionOf,
  failureOf, idOf, iri, type InventoryPage, type InventoryState, type InventoryWork, type Loaded, type MainClient, type MyText,
  type NativeVariants, type RealmChoice, type ReviewMode, workKind, type Submission, type TextDraft, type TextHead,
  type WorkHeader, type WorkMetadata } from './types.ts';

// Studio's server reads. Every read acts as the Studio Agent from the route,
// never silently as the session Agent, and returns a `Loaded` result so one
// region's failure leaves the others standing.

type Answer<T> = { data: T | null; error: { status: number } | null };

/** Main answers 409 when its graph moved during a read that started from scratch; ask once more. */
async function settle<T>(call: () => Promise<Answer<T>>, again = true): Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (again && error?.status === 409) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

type Page<T> = Loaded<{ items: T[]; nextCursor: string | null }>;

// The typed client turns ISO timestamps into Date objects at run time, though
// Main's contract types them as strings. Studio keeps them as ISO strings, so
// a server render and the browser print the same `<time dateTime>`.
const iso = (value: string | Date) => new Date(value).toISOString();
const submissionTimes = <T extends { openedAt: string; updatedAt: string }>(item: T): T =>
  ({ ...item, openedAt: iso(item.openedAt), updatedAt: iso(item.updatedAt) });

// Main has no read of one Agent's texts or submissions for one Work, so the
// Work page filters the Agent's own lists. Five pages bound it; the handoff
// proposes the per-Work Studio read that removes it.
const SCAN_PAGES = 5;

async function scan<T>(page: (cursor: string | undefined) => Promise<Page<T>>, keep: (item: T) => boolean,
  stopAtFirst = false): Promise<Loaded<T[]>> {
  const found: T[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < SCAN_PAGES; index += 1) {
    const loaded = await page(cursor);
    if (!loaded.ok) return found.length ? { ok: true, data: found } : loaded;
    found.push(...loaded.data.items.filter(keep));
    if (stopAtFirst && found.length) break;
    if (!loaded.data.nextCursor) break;
    cursor = loaded.data.nextCursor;
  }
  return { ok: true, data: found };
}

const myTexts = (main: MainClient, actingSubject: string) => (cursor: string | undefined) =>
  settle(() => main.v1.me.contributions.get({ query: { actingSubject, limit: 20, ...(cursor ? { cursor } : {}) } }));

const mySubmissions = (main: MainClient, actingSubject: string) => async (cursor: string | undefined):
  Promise<Page<Submission>> => {
  const page = await settle(() => main.v1.my.submissions.get({ query: { actingSubject, limit: 20,
    ...(cursor ? { cursor } : {}) } })) as Page<Submission>;
  return page.ok ? { ok: true, data: { ...page.data, items: page.data.items.map(submissionTimes) } } : page;
};

/** A cursor Main minted, as a page address carries it back; anything else starts from the first page. */
export const validCursor = (cursor: unknown) => typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048
  ? cursor : undefined;

/** A Book's chapters as its card counts them: the first page of its contents. */
export interface BookChapters { count: number; more: boolean; published: number }

export interface InventoryView {
  page: InventoryPage;
  /** Chapter counts per Book on the page. */
  books: Record<string, BookChapters>;
}

/**
 * The language a Work was created in: its title's, as Main recorded it. Main
 * records English when a creator names no language, so this is only the
 * last resort after the Main Version's own texts ({@link readWorkLanguages}).
 */
const ownLanguageOf = (work: { title: { language: string } }) => canonicalLanguage(work.title.language);

/**
 * One page of a Book's contents as the Studio Agent reads them. Without a
 * language Main reads them in the Main Version's language, which is the
 * language the Book's text is published in; `language` names another.
 */
function contentsPage(main: MainClient, actingSubject: string, book: string, cursor?: string, language?: string) {
  return settle(() => main.v1.works({ id: idOf(book) }).contents.get({ query: { actingSubject, limit: 20,
    ...(language ? { language } : {}), ...(cursor ? { cursor } : {}) } }));
}

/**
 * A Book's first contents page in the language its chapters are written in:
 * the Main Version's, or `fallback` (the Book's own language) while none of
 * the Book's text is published, since chapters can be published before the
 * Book's introduction is.
 */
async function bookContents(main: MainClient, actingSubject: string, book: string, fallback: string):
  Promise<Loaded<ContentsPage>> {
  const first = await contentsPage(main, actingSubject, book);
  return first.ok && first.data.language === null ? contentsPage(main, actingSubject, book, undefined, fallback) : first;
}

/**
 * One page of the Studio Agent's Works: those it wrote (its author credit
 * names it), in one state or all, or those it imported or curates. Main lists
 * a Book, never its chapters; each Book's chapters are counted from its
 * contents (one bounded read per Book on the page).
 */
export async function readInventory(actingSubject: string, filter: { state?: InventoryState; view?: InventoryWork['relationship'] },
  cursor: string | undefined): Promise<Loaded<InventoryView>> {
  const main = await mainApi();
  const page = await settle(() => main.v1.me.agents({ agent: idOf(actingSubject) }).works.get({ query: { limit: 20,
    view: filter.view ?? 'authored', ...(filter.state ? { state: filter.state } : {}), ...(cursor ? { cursor } : {}) } }));
  if (!page.ok) return page;
  const items = page.data.items.map(item => ({ ...item, createdAt: iso(item.createdAt), updatedAt: iso(item.updatedAt),
    submissions: item.submissions.map(submissionTimes) }));
  const books = items.filter(item => workKind(item.types) === 'book');
  const contents = await Promise.all(books.map(async book => [book.id,
    await bookContents(main, actingSubject, book.id, book.texts[0]?.language ?? ownLanguageOf(book))] as const));
  const view: InventoryView = { page: { ...page.data, items }, books: {} };
  for (const [book, loaded] of contents) {
    if (!loaded.ok) continue;
    const chapters = loaded.data.items.filter(item => item.role === 'chapter');
    view.books[book] = { count: chapters.length, more: Boolean(loaded.data.nextCursor),
      published: chapters.filter(item => item.availability === 'available').length };
  }
  return { ok: true, data: view };
}

export interface RealmInfo { name: string; language: string; reviewMode: ReviewMode | null }
export interface WorkName { value: string; language: string }

/** Realm names and review modes, read as the Studio Agent so a Realm it belongs to answers too. At most 20. */
async function realmInfo(main: MainClient, actingSubject: string, realms: readonly string[], locale: UiLocale):
  Promise<Record<string, RealmInfo>> {
  const entries = await Promise.all([...new Set(realms)].slice(0, 20).map(async realm => {
    const loaded = await settle(() => main.v1.realms({ realm: idOf(realm) }).get({ query: { language: locale,
      actingSubject } }));
    return loaded.ok ? [[realm, { name: loaded.data.name.value, language: loaded.data.name.language,
      reviewMode: loaded.data.reviewMode }] as const] : [];
  }));
  return Object.fromEntries(entries.flat());
}

/**
 * Work titles by IRI, as the Studio Agent: one batch read, then the Work's own
 * header for any the batch leaves out (it does not yet name a private Work to
 * the writer who created it). A page names at most 20 Works.
 */
async function workNames(main: MainClient, actingSubject: string, works: readonly string[], locale: UiLocale):
  Promise<Record<string, WorkName>> {
  const resources = [...new Set(works)].slice(0, 20);
  if (!resources.length) return {};
  const loaded = await settle(() => main.v1.resources.summaries.post({ profile: 'resource-summary-batch-v1', resources,
    actingSubject, language: locale }), false);
  const names: Record<string, WorkName> = loaded.ok ? Object.fromEntries(loaded.data.summaries.flatMap(summary =>
    summary.status === 'available' ? [[summary.reference, { value: summary.name.value, language: summary.name.language }]]
      : [])) : {};
  await Promise.all(resources.filter(work => !names[work]).map(async work => {
    const header = await settle(() => main.v1.works({ id: idOf(work) }).get({ query: { language: locale, actingSubject } }));
    if (header.ok) names[work] = { value: header.data.title.value, language: header.data.title.language };
  }));
  return names;
}

export interface ReviewPage {
  submissions: Page<Submission>;
  realms: Record<string, RealmInfo>;
  works: Record<string, WorkName>;
}

/** One page of the Studio Agent's Realm submissions, with the Works' titles and the Realms' names. */
export async function readReviewPage(actingSubject: string, cursor: string | undefined, locale: UiLocale):
  Promise<ReviewPage> {
  const main = await mainApi();
  const submissions = await mySubmissions(main, actingSubject)(cursor);
  if (!submissions.ok) return { submissions, realms: {}, works: {} };
  const items = submissions.data.items;
  const [realms, works] = await Promise.all([realmInfo(main, actingSubject, items.map(item => item.realm), locale),
    workNames(main, actingSubject, items.map(item => item.work), locale)]);
  return { submissions, realms, works };
}

export interface StudioWork { header: WorkHeader; metadata: Loaded<WorkMetadata> }

/** One Work as the Studio Agent sees it: its header and its editable details. */
export const readStudioWork = cache(async (actingSubject: string, id: string, locale: UiLocale):
  Promise<Loaded<StudioWork>> => {
  const main = await mainApi();
  const [header, metadata] = await Promise.all([
    settle(() => main.v1.works({ id }).get({ query: { language: locale, actingSubject } })),
    settle(() => main.v1.works({ id }).metadata.get({ query: { actingSubject } })),
  ]);
  return header.ok ? { ok: true, data: { header: header.data, metadata } } : header;
});

export interface WorkLanguages {
  /** What the Work is written in: its Main Version's published languages, else its title's. */
  all: string[];
  /** The one Studio writes in by default: the Studio Agent's own published text's, else the first of `all`. */
  own: string;
}

/**
 * The languages of a Work's Main Version: the languages its public texts are
 * in, the Studio Agent's first. Main answers this public read from its
 * publication graph, so it names what readers get, whatever the title says.
 */
export const readWorkLanguages = (actingSubject: string, header: Pick<WorkHeader, 'mainVersion' | 'title'>,
  main?: MainClient) => workLanguages(actingSubject, header.mainVersion, ownLanguageOf(header), main);

// Keyed by strings: React's cache compares arguments by identity.
const workLanguages = cache(async (actingSubject: string, mainVersion: string, fallback: string, client?: MainClient):
  Promise<WorkLanguages> => {
  const main = client ?? await mainApi();
  const loaded = await settle(() => main.v1['main-versions']({ mainVersion: idOf(mainVersion) })['native-variants']
    .get({ query: {} }));
  const variants = loaded.ok ? [...loaded.data.variants].sort((a, b) =>
    Number(b.author === actingSubject) - Number(a.author === actingSubject)) : [];
  const all = [...new Set(variants.map(variant => canonicalLanguage(variant.language)))];
  return all.length ? { all, own: all[0]! } : { all: [fallback], own: fallback };
});

export interface BookChaptersView {
  page: Loaded<ContentsPage> | { ok: false; failure: 'none' };
  /** The language the chapters are written and published in. */
  language: string;
}

/**
 * Starts reading one page of a Book's chapters before the Book's header is
 * in, so both arrive together. Main reads them in the Main Version's language.
 */
export async function startChapters(actingSubject: string, book: string, cursor: string | undefined):
  Promise<Loaded<ContentsPage>> {
  return contentsPage(await mainApi(), actingSubject, book, cursor);
}

/**
 * One page of a Book's chapters in order, in the language they are written
 * in: the Studio Agent's own published language when the Main Version has
 * several, the Main Version's when it has one, the Book's own while it has
 * none. `none` when the Book has no composition yet (Main answers 404 for
 * that and for an unreadable Book alike; the page already read the Book).
 */
export async function readChapters(actingSubject: string, header: Pick<WorkHeader, 'id' | 'mainVersion' | 'title'>,
  { cursor, started, main: client }: { cursor?: string; started?: Promise<Loaded<ContentsPage>>; main?: MainClient } = {}):
  Promise<BookChaptersView> {
  const main = client ?? await mainApi();
  const [first, languages] = await Promise.all([started ?? contentsPage(main, actingSubject, header.id, cursor),
    readWorkLanguages(actingSubject, header, main)]);
  const language = first.ok && first.data.language !== null && languages.all.length < 2
    ? canonicalLanguage(first.data.language) : languages.own;
  const page = first.ok && first.data.language?.toLowerCase() !== language.toLowerCase()
    ? await contentsPage(main, actingSubject, header.id, cursor, language) : first;
  return { language, page: !page.ok && page.failure === 'missing' && !cursor ? { ok: false, failure: 'none' } : page };
}

export type ChapterState = 'empty' | 'draft' | 'published' | 'changed';

/** Who writes a chapter, of the identities this person acts as. */
export type ChapterWriter = { kind: 'self' } | { kind: 'agent'; agent: AgentOption } | { kind: 'unknown' };

export interface ChapterFact {
  writer: ChapterWriter;
  /** Where the chapter stands for its writer, from its Content variants; null when Main didn't say. */
  state: ChapterState | null;
  /** The chapter and its title as its writer sees them, when the Studio Agent can't see them. */
  target?: string;
  label?: ContentsItem['label'];
}

/** What Studio learned about each chapter on a page, by occurrence. */
export type ChapterFacts = Record<string, ChapterFact>;

const revisionPrefix = 'urn:rezics:content:revision:';

/**
 * Where a chapter stands, from its writer's Content variants: nothing saved
 * yet, drafts only, published, or published with a newer draft in the
 * language readers get it in (`selected` is the revision they get).
 */
export function chapterState(variants: ContentVariantPage['items'], language: string, selected: string | null): ChapterState {
  if (!variants.length) return 'empty';
  const read = variants.find(item => item.language.tag?.toLowerCase() === language.toLowerCase());
  if (selected && read) return read.draftHead === selected.slice(revisionPrefix.length) ? 'published' : 'changed';
  return variants.some(item => item.publicationHead && item.eligibilityHead) ? 'published' : 'draft';
}

/** Runs `work` over `items` at most `limit` at a time, so one page never floods Main. */
async function bounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

/**
 * Who writes each chapter on a page and where it stands. Main lists a
 * chapter's Content variants only to the Agent that writes it (or holds a
 * grant to), so one read per chapter tells both. A chapter the Studio Agent doesn't write is
 * asked of this person's other identities: a chapter it can't even see (a
 * private one) through the Book's contents as each of them, a public one
 * through its variants, one identity after another. At most one read per
 * chapter and identity, five chapters at a time; a chapter none of them
 * writes stays `unknown`.
 */
export async function readChapterFacts(agent: AgentOption, agents: readonly AgentOption[], book: string,
  chapters: BookChaptersView, first: boolean, client?: MainClient): Promise<ChapterFacts> {
  if (!chapters.page.ok) return {};
  const main = client ?? await mainApi();
  const rows = chapters.page.data.items.filter(item => item.role === 'chapter');
  const others = agents.filter(option => option.iri !== agent.iri);
  const variantsOf = (target: string, actingSubject: string) => settle(() =>
    main.v1.works({ id: idOf(target) })['content-variants'].get({ query: { actingSubject, limit: 20 } }), false);
  const facts: ChapterFacts = {};
  const state = (items: ContentVariantPage['items'], row: ContentsItem) =>
    chapterState(items, chapters.language, row.availability === 'available' ? row.selectedRevision : null);
  const unclaimed: ContentsItem[] = [];
  await bounded(rows.filter(row => row.target), 5, async row => {
    const own = await variantsOf(row.target!, agent.iri);
    facts[row.occurrence] = own.ok ? { writer: { kind: 'self' }, state: state(own.data.items, row) }
      : { writer: { kind: 'unknown' }, state: null };
    // Main refused or didn't find the variants: another identity may write the chapter. A failure says nothing.
    if (!own.ok && own.failure !== 'unavailable') unclaimed.push(row);
  });
  await bounded(unclaimed, 5, async row => {
    for (const other of others) {
      const theirs = await variantsOf(row.target!, other.iri);
      if (!theirs.ok) continue;
      facts[row.occurrence] = { writer: { kind: 'agent', agent: other }, state: state(theirs.data.items, row) };
      return;
    }
  });
  // A later page's cursor is bound to the Studio Agent, so only the first page can be read as another identity.
  const hidden = rows.filter(row => !row.target);
  if (!hidden.length || !first || !others.length) return facts;
  const views = await bounded(others, 5, async other => ({ other,
    page: await contentsPage(main, other.iri, book, undefined, chapters.language) }));
  await bounded(hidden, 5, async row => {
    const seen = views.flatMap(({ other, page }) => {
      const item = page.ok ? page.data.items.find(entry => entry.occurrence === row.occurrence && entry.target) : undefined;
      return item ? [{ other, item }] : [];
    })[0];
    if (!seen) { facts[row.occurrence] = { writer: { kind: 'unknown' }, state: null }; return; }
    const theirs = await variantsOf(seen.item.target!, seen.other.iri);
    facts[row.occurrence] = { writer: { kind: 'agent', agent: seen.other }, target: seen.item.target!,
      label: seen.item.label, state: theirs.ok ? state(theirs.data.items, seen.item) : null };
  });
  return facts;
}

/** The Studio Agent's texts of one Work, one per language. */
export async function readWorkTexts(actingSubject: string, work: string): Promise<Loaded<MyText[]>> {
  const main = await mainApi();
  return scan(myTexts(main, actingSubject), item => item.work?.id === work);
}

export interface WorkSubmissions { submissions: Loaded<Submission[]>; realms: Record<string, RealmInfo> }

/** What Realms decided about one Work's submissions by the Studio Agent. */
export async function readWorkSubmissions(actingSubject: string, work: string, locale: UiLocale): Promise<WorkSubmissions> {
  const main = await mainApi();
  const submissions = await scan(mySubmissions(main, actingSubject), item => item.work === work);
  const realms = submissions.ok ? await realmInfo(main, actingSubject, submissions.data.map(item => item.realm), locale)
    : {};
  return { submissions, realms };
}

/** The Work's public texts by this Agent: what a Realm can review. */
export async function readPublishedTexts(actingSubject: string, mainVersion: string):
  Promise<Loaded<NativeVariants['variants']>> {
  const main = await mainApi();
  const loaded = await settle(() => main.v1['main-versions']({ mainVersion: idOf(mainVersion) })['native-variants']
    .get({ query: {} }));
  return loaded.ok ? { ok: true, data: loaded.data.variants.filter(variant => variant.author === actingSubject) } : loaded;
}

export interface RealmOption extends Omit<RealmChoice, 'reviewMode'> { reviewMode: ReviewMode | null }

/** Realms to submit to: the first page of the directory, each with its review mode. */
export async function readRealmChoices(actingSubject: string, locale: UiLocale): Promise<Loaded<RealmOption[]>> {
  const main = await mainApi();
  const loaded = await settle(() => mainApiWithToken(undefined).v1.realms.get({ query: { limit: 20, language: locale } }));
  if (!loaded.ok) return loaded;
  const info = await realmInfo(main, actingSubject, loaded.data.items.map(item => item.id), locale);
  return { ok: true, data: loaded.data.items.map(item => ({ ...item, reviewMode: info[item.id]?.reviewMode ?? null })) };
}

/** The Work's accepted tags, as readers see them. */
export async function readTags(actingSubject: string, work: string, locale: UiLocale): Promise<Loaded<ClassificationPage>> {
  const main = await mainApi();
  return settle(() => main.v1.works({ id: idOf(work) }).classifications.get({ query: { actingSubject, language: locale,
    scope: 'global', limit: 20 } }));
}

export interface StudioText {
  /** The text's current draft head, from Main. */
  head: string | null;
  /** The exact revision the editor opened: the head, or the revision the address names. */
  draft: Loaded<TextDraft>;
  publication: MyText['publication'] | null;
  publicationHead: string | null;
}

/** One text to edit, at Main's current draft head (or the revision the address names when Main cannot say). */
export async function readStudioText(actingSubject: string, contribution: string, revision: string | null):
  Promise<StudioText> {
  const main = await mainApi();
  const current: Loaded<TextHead> = await settle(() => main.v1.contributions({ contribution }).get({ query: { actingSubject } }));
  const head = current.ok ? current.data.draftHead : null;
  const exact = head ?? (revision ? iri(revision) : null);
  if (!exact) return { head: null, publication: null, publicationHead: null,
    draft: { ok: false, failure: current.ok ? 'missing' : current.failure } };
  const draft = await settle(() => main.v1.contributions({ contribution })
    .drafts({ revision: idOf(exact) }).get({ query: { actingSubject } }));
  const publicationHead = current.ok ? current.data.publicationHead : null;
  return { head, draft, publicationHead,
    publication: current.ok ? publicationHead ? 'public' : 'draft' : null };
}

/** One Work's header as the Studio Agent reads it. */
export const readWorkHeader = cache(async (actingSubject: string, id: string, locale: UiLocale): Promise<Loaded<WorkHeader>> => {
  const main = await mainApi();
  return settle(() => main.v1.works({ id }).get({ query: { language: locale, actingSubject } }));
});

export interface StudioChapter {
  chapter: { id: string; title: WorkName; language: string; direction: 'ltr' | 'rtl' };
  variant: string;
  /**
   * Where the draft head came from: Main's variant list, the address (this
   * device's last save), or nowhere yet (a new chapter, or a device that has
   * not written it, which meets any newer save as a conflict).
   */
  basis: 'main' | 'address' | 'none';
  head: string | null;
  body: string;
  digest: string | null;
  epoch: string | null;
  publication: string | null;
  eligibility: string | null;
}

/**
 * One chapter to write: its title and language, and its draft at the best
 * head Studio can know. A chapter is written in its Book's language, which the
 * chapter list names (`requested`); an address without one opens the
 * chapter's existing text, else writes in the language of its title.
 */
export async function readStudioChapter(actingSubject: string, chapter: string, revision: string | null, locale: UiLocale,
  requested: string | null = null): Promise<Loaded<StudioChapter>> {
  const main = await mainApi();
  const [header, listed] = await Promise.all([readWorkHeader(actingSubject, chapter, locale),
    settle(() => main.v1.works({ id: chapter })['content-variants'].get({ query: { actingSubject } }))]);
  if (!header.ok) return header;
  const titled = ownLanguageOf(header.data);
  const written = listed.ok ? listed.data.items.map(item => item.language.tag).filter((tag): tag is string => !!tag) : [];
  const language = canonicalLanguage(requested
    ?? written.find(tag => tag.toLowerCase() === titled.toLowerCase()) ?? written[0] ?? titled);
  const variant = await chapterVariant(header.data.id, language);
  // Main lists a chapter's variant heads to the Agent that writes it or holds a grant to; to others it answers 404.
  const known = listed.ok ? listed.data.items.find(item => item.variantId === variant)
    ?? listed.data.items.find(item => item.language.tag?.toLowerCase() === language.toLowerCase()) : undefined;
  const head = known?.draftHead ?? (listed.ok ? null : revision);
  const base = { chapter: { id: header.data.id, title: { value: header.data.title.value, language },
    language, direction: directionOf(language) }, variant: known?.variantId ?? variant,
  publication: known?.publicationHead ?? null, eligibility: known?.eligibilityHead ?? null };
  if (!head) {
    return { ok: true, data: { ...base, basis: listed.ok ? 'main' : 'none', head: null, body: '', digest: null,
      epoch: listed.ok ? listed.data.sourcePosition.dataEpoch : null } };
  }
  const exact = await settle(() => main.v1['content-revisions']({ revision: head }).get({ query: { actingSubject } }));
  if (!exact.ok) return exact;
  const body = exact.data.body.body;
  if (exact.data.reference.resourceId !== header.data.id || typeof body !== 'string') {
    return { ok: false, failure: 'missing' };
  }
  return { ok: true, data: { ...base, variant: exact.data.reference.variantId, basis: known ? 'main' : 'address',
    head, body, digest: exact.data.reference.byteDigest, epoch: listed.ok ? listed.data.sourcePosition.dataEpoch : null } };
}
