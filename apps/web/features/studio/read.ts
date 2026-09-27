import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApi, mainApiWithToken } from '../api/main.ts';
import { chapterVariant } from './content-api.ts';
import { canonicalLanguage, type ClassificationPage, type ContentsPage, directionOf, failureOf, idOf, iri,
  type InventoryPage, type InventoryState, type Loaded, type MainClient, type MyText, type NativeVariants,
  type RealmChoice, type ReviewMode, workKind, type Submission, type TextDraft, type TextHead, type WorkHeader,
  type WorkMetadata } from './types.ts';

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
  /** Works on the page that are chapters of a Book on the page; they are listed in their Book. */
  chapters: string[];
}

/**
 * One page of the Studio Agent's Works, all of them or those in one state, with
 * each Book's chapters counted. Main's inventory lists a chapter as a Work of
 * its own and names no Book for it, so Studio reads the contents of the Books
 * on the page (one bounded read each) and folds their chapters into them.
 */
export async function readInventory(actingSubject: string, state: InventoryState | undefined, cursor: string | undefined):
  Promise<Loaded<InventoryView>> {
  const main = await mainApi();
  const page = await settle(() => main.v1.me.agents({ agent: idOf(actingSubject) }).works.get({ query: { limit: 20,
    ...(state ? { state } : {}), ...(cursor ? { cursor } : {}) } }));
  if (!page.ok) return page;
  const books = page.data.items.filter(item => workKind(item.types) === 'book');
  const contents = await Promise.all(books.map(async book => [book.id, await settle(() =>
    main.v1.works({ id: idOf(book.id) }).contents.get({ query: { actingSubject, language: writingLanguageOf(book),
      limit: 20 } }))] as const));
  const items = page.data.items.map(item => ({ ...item, createdAt: iso(item.createdAt), updatedAt: iso(item.updatedAt),
    submissions: item.submissions.map(submissionTimes) }));
  const view: InventoryView = { page: { ...page.data, items }, books: {}, chapters: [] };
  for (const [book, loaded] of contents) {
    if (!loaded.ok) continue;
    const chapters = loaded.data.items.filter(item => item.role === 'chapter');
    view.books[book] = { count: chapters.length, more: Boolean(loaded.data.nextCursor),
      published: chapters.filter(item => item.availability === 'available').length };
    view.chapters.push(...chapters.flatMap(item => item.target && item.target !== book ? [item.target] : []));
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

/** The language a Work is written in: its title's, as Main recorded it at creation. */
export const writingLanguageOf = (work: { title: { language: string } }) => canonicalLanguage(work.title.language);

/**
 * One page of a Book's chapters in order. `none` when the Book has no
 * composition yet (Main answers 404 for that and for an unreadable Book alike;
 * the page already read the Book). Chapters count as published in the Book's
 * own language.
 */
export async function readChapters(actingSubject: string, header: Pick<WorkHeader, 'id' | 'title'>,
  cursor: string | undefined): Promise<Loaded<ContentsPage> | { ok: false; failure: 'none' }> {
  const main = await mainApi();
  const loaded = await settle(() => main.v1.works({ id: idOf(header.id) }).contents.get({ query: { actingSubject,
    language: writingLanguageOf(header), limit: 20, ...(cursor ? { cursor } : {}) } }));
  return !loaded.ok && loaded.failure === 'missing' && !cursor ? { ok: false, failure: 'none' } : loaded;
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

export interface RealmOption extends RealmChoice { reviewMode: ReviewMode | null }

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

/** One chapter to write: its title and language, and its draft at the best head Studio can know. */
export async function readStudioChapter(actingSubject: string, chapter: string, revision: string | null, locale: UiLocale):
  Promise<Loaded<StudioChapter>> {
  const main = await mainApi();
  const header = await readWorkHeader(actingSubject, chapter, locale);
  if (!header.ok) return header;
  const language = writingLanguageOf(header.data);
  const [variant, listed] = await Promise.all([chapterVariant(header.data.id, language),
    settle(() => main.v1.works({ id: chapter })['content-variants'].get({ query: { actingSubject } }))]);
  // Main lets a writer list their variant heads only with an explicit grant; without one it answers 404.
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
