import { cookies } from 'next/headers';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { cache } from 'react';
import { failureOf } from './failure.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { type ReaderSeed, readerEntry } from '../catalogue/reader-store.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { chapterHref, chapterPlaceHref, type ContentsQuery, idOf, iriOf, mainScope, parseWorkRef, textHref,
  type VersionQuery, type WorkRef, type WorkScope, workHref } from './route.ts';
import type { AdoptionPage, AgentCreditPage, AgentWorksPage, AlsoEnjoyedPage, ChapterRead, ClassificationPage,
  ContentsPage, CreditPage, DiscussionPage, HistoryKind, HistoryPage, Loaded, Progress, RatingContextPage, RatingRead,
  ReadFailure, RealmHeader, Reviewer, ReviewPage, ReviewQuery, RecipeWorkPage, HubWorkPage,
  VersionPage, WorkHeader, WorkStats, WorkText }
  from './types.ts';

// Server reads for the Work page. Each returns a `Loaded` result instead of
// throwing, so one region's failure never takes down another. Reads are
// cached per request: the page, its metadata and several regions share one
// Main call.

/**
 * Who reads. A signed-in person whose session Agent (kept by Main for this
 * web session) is eligible reads as that Agent, so their private Works, Mine
 * and progress resolve; anyone else reads the public view. Main requires
 * `actingSubject` with a bearer token, so a person without an eligible Agent
 * reads publicly and Mine asks them to choose one.
 */
const reader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const acting = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject ?? undefined : undefined;
  return { main: mainApiWithToken(acting ? token : undefined), actingSubject: acting, signedIn: Boolean(token) };
});

/** The session Agent the page reads as, for client components that write as it (reading progress). */
export async function readingAgent(): Promise<{ signedIn: boolean; actingSubject: string | null }> {
  const { signedIn, actingSubject } = await reader();
  return { signedIn, actingSubject: actingSubject ?? null };
}

export { failureOf };

type Answer<T> = { data: T | null; error: { status: number } | null };

/**
 * One Main read as a `Loaded` result. Main answers 409 when the graph moved
 * during the read; a read that is not continuing a cursor simply starts
 * again, once, as Main asks. A moved cursor is the reader's to restart.
 */
async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409 && !cursor) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** These two type pages use JSON null for a visible Work without an owner-specific publication. */
async function settleNullable<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T | null>> {
  try {
    const { data, error } = await call();
    return error ? { ok: false, failure: failureOf(error.status) } : { ok: true, data };
  } catch { return { ok: false, failure: 'unavailable' }; }
}

export type ResolvedRef =
  | { kind: 'work'; id: string }
  /** The slug was renamed or merged; the page moves to the current one. */
  | { kind: 'moved'; slug: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/** A `/w/{ref}` segment to a Work UUID. Slugs never become alternate Work identities. */
export const resolveWorkRef = cache(async (ref: WorkRef): Promise<ResolvedRef> => {
  if (ref.kind === 'id') return { kind: 'work', id: ref.id };
  const { main } = await reader();
  try {
    // A renamed slug answers 308 with the current one; read it rather than follow it.
    const { data, error } = await main.v1.addresses.work({ slug: ref.slug }).get({ fetch: { redirect: 'manual' } });
    if (data) return { kind: 'work', id: data.work.slice(-36) };
    if (error?.status === 308) return { kind: 'moved', slug: error.value.canonical.slug };
    return error && failureOf(error.status) === 'missing' ? { kind: 'missing' } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
});

export const readWorkHeader = cache(async (id: string, _locale: UiLocale): Promise<Loaded<WorkHeader>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).get({ query: { actingSubject } }));
});

export async function readRecipeWorkPage(id: string, servings?: number): Promise<Loaded<RecipeWorkPage | null>> {
  const { main, actingSubject } = await reader();
  return settleNullable(() => main.v1.recipes.works({ id }).get({ query: { actingSubject,
    ...(servings === undefined ? {} : { servings }) } }));
}

export async function readHubWorkPage(id: string): Promise<Loaded<HubWorkPage | null>> {
  const { main, actingSubject } = await reader();
  return settleNullable(() => main.v1.hub.works({ id }).get({ query: { actingSubject } }));
}

export type WorkResolution =
  | { kind: 'work'; id: string; header: WorkHeader }
  | { kind: 'moved'; slug: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/**
 * The Work behind a `/w/{ref}` page, shared by its layout, views and
 * metadata. Metadata reads this directly: vinext streams metadata, so a
 * `notFound()` thrown there would answer 200.
 */
export const resolveWork = cache(async (ref: string, locale: UiLocale): Promise<WorkResolution> => {
  const parsed = parseWorkRef(ref);
  if (!parsed) return { kind: 'missing' };
  const resolved = await resolveWorkRef(parsed);
  if (resolved.kind !== 'work') return resolved;
  const header = await readWorkHeader(resolved.id, locale);
  if (header.ok) return { kind: 'work', id: resolved.id, header: header.data };
  return { kind: header.failure === 'missing' ? 'missing' : 'unavailable' };
});

/**
 * The Work for a layout or view. A missing or invisible Work is a 404 and a
 * renamed slug moves to the current one; when Main cannot answer, the page
 * says the Work is unavailable rather than pretending it does not exist. A
 * chapter is read in its Book: its address opens the Book's reader there.
 */
export async function loadWork(ref: string, locale: UiLocale):
  Promise<{ ok: true; id: string; header: WorkHeader } | { ok: false }> {
  const work = await resolveWork(ref, locale);
  if (work.kind === 'missing') notFound();
  if (work.kind === 'moved') permanentRedirect(localizedPath(workHref(work.slug), locale));
  const place = work.kind === 'work' && work.header.partOf ? chapterPlaceHref(work.header.partOf) : null;
  if (place) redirect(localizedPath(place, locale));
  return work.kind === 'work' ? { ok: true, id: work.id, header: work.header } : { ok: false };
}

export const readReleases = cache(async (id: string) => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).releases.get({ query: { limit: 20, actingSubject } }));
});

export const readCredits = cache(async (id: string): Promise<Loaded<CreditPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).credits.get({ query: { actingSubject } }));
});

export const readAdoptions = cache(async (id: string, _locale: UiLocale): Promise<Loaded<AdoptionPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).adoptions.get({ query: { actingSubject } }));
});

export const readRealm = cache(async (realm: string, _locale: UiLocale): Promise<Loaded<RealmHeader>> => {
  const { main } = await reader();
  return settle(() => main.v1.realms({ realm }).get({ query: {} }));
});

/** Mine needs a signed-in person acting as an Agent; say which step is missing before asking Main. */
async function scopeReader(scope: WorkScope) {
  const current = await reader();
  if (scope.kind !== 'mine' || current.actingSubject) return { ...current, failure: null };
  return { ...current, failure: (current.signedIn ? 'identity' : 'sign-in') as ReadFailure };
}

export const readClassifications = cache(async (id: string, _locale: UiLocale, scope: WorkScope):
  Promise<Loaded<ClassificationPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).classifications.get({
    query: { actingSubject, ...mainScope(scope) } }));
});

/**
 * The rating summary for one scope. Main never picks a question when several
 * Contexts exist, so the page does, visibly: the one in the URL, else the
 * first Main lists, and it names the Context it shows.
 */
export const readRatings = cache(async (id: string, scope: WorkScope, contextId: string | undefined):
  Promise<Loaded<RatingRead>> => {
  const { main, actingSubject, failure } = await scopeReader(scope);
  if (failure) return { ok: false, failure };
  const contexts = await settle<RatingContextPage>(() => main.v1.works({ id })['rating-contexts'].get({
    query: { actingSubject, ...mainScope(scope) } }));
  if (!contexts.ok) return contexts;
  const items = contexts.data.items;
  const context = items.find(item => item.context === (contextId && iriOf(contextId))) ?? items[0] ?? null;
  const summary = await settle(() => main.v1.works({ id }).ratings.get({
    query: { actingSubject, ...mainScope(scope), context: context?.context } }));
  return summary.ok ? { ok: true, data: { contexts: items, context, summary: summary.data } } : summary;
});

export async function readVersions(id: string, _locale: UiLocale, filter: VersionQuery): Promise<Loaded<VersionPage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).versions.get({ query: { actingSubject,
    kind: filter.kind, contentLanguage: filter.language, cursor: filter.cursor } }), filter.cursor);
}

/** The Work's public activity, newest first: metadata revisions, publications and placed replies. */
export async function readHistory(id: string, kind: HistoryKind | undefined, cursor: string | undefined):
  Promise<Loaded<HistoryPage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).history.get({ query: { actingSubject, kind, cursor } }), cursor);
}

/** Reviewed replies placed in public Realms, newest first; one Realm when the scope names it. */
export async function readDiscussion(id: string, realm: string | undefined, cursor: string | undefined):
  Promise<Loaded<DiscussionPage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).discussion.get({ query: { actingSubject,
    realm: realm ? iriOf(realm) : undefined, cursor } }), cursor);
}

/** Works an Agent is credited on, newest first, for "More by" on a Work page. */
export const readAgentWorks = cache(async (agent: string, _locale: UiLocale): Promise<Loaded<AgentWorksPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.agents({ id: agent.slice(-36) }).works.get({ query: { actingSubject,
    limit: 12 } }));
});

/**
 * The numbers under the header's rating: people whose public library has the
 * Work on Currently reading, and the reviews answering `context`, everyone's
 * rating question the header shows.
 */
export const readWorkStats = cache(async (id: string, context: string | undefined): Promise<Loaded<WorkStats>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id })['reader-stats'].get({ query: { actingSubject, context } }));
});

/**
 * Works this one's readers also enjoyed, or similar ones when too few have
 * read it, each card saying which (`basis`). One page of twelve: three pages
 * of the row on a wide screen.
 */
export const readAlsoEnjoyed = cache(async (id: string, _locale: UiLocale): Promise<Loaded<AlsoEnjoyedPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id })['also-enjoyed'].get({ query: { actingSubject,
    limit: 12 } }));
});

/** A page of this Work's reviews for one rating Context; the reader's own comes first on page one. */
export async function readReviews(id: string, query: Omit<ReviewQuery, 'actingSubject'>): Promise<Loaded<ReviewPage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).reviews.get({ query: { ...query, actingSubject } }), query.cursor);
}

/** An Agent's public name and handle, once per request, for reviews and credits Main names by IRI. */
export const readReviewer = cache(async (agent: string): Promise<Reviewer | null> => {
  const { main, actingSubject } = await reader();
  const profile = await settle(() => main.v1.agents({ id: agent.slice(-36) }).get({ query: { actingSubject } }));
  return profile.ok ? { name: profile.data.displayName, handle: profile.data.handle } : null;
});

/**
 * The reader's shelf status and own ratings for this Work. Null when they act
 * as no Agent or Main denies that Agent a reader library; empty when Main could
 * not answer, so the controls read it again in the browser.
 */
export const readReaderState = cache(async (id: string): Promise<ReaderSeed | null> => {
  const { main, actingSubject } = await reader();
  if (!actingSubject) return null;
  const state = await settle(() => main.v1.works({ id })['reader-state'].get({ query: { actingSubject } }));
  if (state.ok) return { [state.data.work]: readerEntry(state.data) };
  return state.failure === 'sign-in' ? null : {};
});

export const readAgentCredits = cache(async (id: string): Promise<Loaded<AgentCreditPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id })['agent-credits'].get({ query: { actingSubject } }));
});

/** One level of the Main Version's table of contents: a group's children, or the top level. */
export async function readContents(id: string, query: ContentsQuery): Promise<Loaded<ContentsPage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).contents.get({ query: { actingSubject,
    parent: query.parent ? iriOf(query.parent) : undefined, language: query.language, cursor: query.cursor } }),
  query.cursor);
}

/**
 * The language of the one text a Work without contents is read as: the one
 * Main selects for the reader's language (`selected`), else the Main
 * Version's selected text in any language, as Main's Versions read marks it
 * (English first, as Main picks). Null when the Work has no selected text.
 */
export const oneTextLanguage = cache(async (id: string, locale: UiLocale, selected: string | null):
  Promise<string | null> => {
  if (selected) return selected;
  const versions = await readVersions(id, locale, { kind: 'text-variant' });
  const languages = versions.ok ? versions.data.items.filter(item => item.selected).map(item => item.language) : [];
  return languages.find(language => language === 'en') ?? languages.sort()[0] ?? null;
});

/**
 * Where "Read" leads. A reader already in the Work continues at the next
 * chapter they have not read, as Main's Continue read gives it; anyone else
 * starts at chapter 1, found by descending the first parts of the contents
 * (at most three levels, one page each). A Work with no contents but a
 * selected text is read as that one text. Null when the Work has nothing to
 * read; `contents` when Main could not say, so Contents explains.
 */
export const readStart = cache(async (id: string, work: string, locale: UiLocale, selected: string | null):
  Promise<ReadStart> => {
  const { main, actingSubject } = await reader();
  if (actingSubject) {
    const next = await settle(() => main.v1.me.continue.get({ query: { actingSubject, limit: 6 } }));
    const item = next.ok ? next.data.items.find(entry => entry.work === work) : undefined;
    if (item) {
      return { kind: item.lastPosition ? 'continue' : 'start', href: item.nextUnread.href, chapter: item.nextUnread.title };
    }
  }
  const nothing = async (): Promise<ReadStart> => await oneTextLanguage(id, locale, selected)
    ? { kind: 'start', href: textHref(id), chapter: null } : null;
  let parent: string | undefined;
  for (let depth = 0; depth < 3; depth += 1) {
    const level = await readContents(id, { parent });
    if (!level.ok) return depth === 0 && level.failure === 'missing' ? nothing() : { kind: 'contents' };
    const first = level.data.items.find(item => item.availability === 'available');
    const occurrence = first ? idOf(first.occurrence) : null;
    if (!first || !occurrence) return depth === 0 && !level.data.items.length ? nothing() : { kind: 'contents' };
    if (first.role === 'chapter') return { kind: 'start', href: chapterHref(id, occurrence), chapter: first.label?.value ?? null };
    parent = occurrence;
  }
  return { kind: 'contents' };
});

export type ReadStart =
  | { kind: 'start' | 'continue'; href: string; chapter: string | null }
  | { kind: 'contents' }
  | null;

/**
 * The text a Work is read as when it has no contents: its Main Version's selected publication, in the
 * named language or the one Main selects.
 */
export const readText = cache(async (mainVersion: string, language: string | undefined): Promise<Loaded<WorkText>> => {
  const { main } = await reader();
  const id = idOf(mainVersion);
  if (!id) return { ok: false, failure: 'missing' };
  return settle(() => main.v1['main-versions']({ mainVersion: id }).selection.get({ query: { language } }));
});

/** One chapter's exact body with its neighbours, in the Work's selected language unless one is named. */
export const readChapter = cache(async (chapter: string, language: string | undefined):
  Promise<Loaded<ChapterRead>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.chapters({ id: chapter }).get({ query: { actingSubject, language } }));
});

/**
 * The reader's own progress in a chapter. Main keeps it per Account for Works
 * the reader may read; `missing` means Main keeps none for this reader here.
 */
export async function readProgress(target: ChapterRead['progress']): Promise<Loaded<Progress>> {
  const { main, actingSubject, signedIn } = await reader();
  if (!actingSubject) return { ok: false, failure: signedIn ? 'identity' : 'sign-in' };
  return settle(() => main.v1.compositions({ id: target.composition.slice(-36) })
    .occurrences({ occurrence: target.occurrence.slice(-36) }).progress
    .get({ query: { actingSubject, selectedRevision: target.selectedRevision } }));
}
