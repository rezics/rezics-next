import { readAnimeRelationsRatings, readAnimeRelationsStats } from './anime-relations-recorded-page.ts';
import { cookies, headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { resolveAddress } from '../address/server.ts';
import type { ResolvedAddress } from '../address/client.ts';
import { addressKey } from '../address/path.ts';
import { requestLocale } from '../../i18n/server.ts';
import { followHref } from '../entity-page/href.ts';
import { recipeReadingReads } from './recipe-reading-recorded-page.ts';
import { failureOf } from './failure.ts';
import type { MainClient } from '../discover/types.ts';
import { booksEditionReads, settle, refusedRead, settleNullable } from './books-edition-page.read.ts';
import { readSuppliedContents, readSuppliedStart } from './games-hub-recorded-page.ts';
import { booksLanguageReads } from './books-language-recorded-page.ts';
import { WORK_MISSING_HEADER } from './admission.ts';
import { mainApiWithToken, readPlatformAccess } from '../api/main.ts';
import { operationOpen, platformClosed } from '../api/platform-access.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { BrowseReadError, discoveryApi, type ListPage, type RatingPopulation } from '../discover/api.ts';
import { sessionAgentRead } from '../auth/session.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { type ReaderSeed, readerEntry } from '../catalogue/reader-store.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { type ContentsQuery, idOf, iriOf, parseWorkRef, postPlaceHref,
  type VersionQuery, type WorkRef, type WorkScope, workHref } from './route.ts';
import type { EditionPreference, ProgressSummary } from '../tracking/types.ts';
import type { AdoptionPage, AgentCreditPage, AgentWorksPage, AlsoEnjoyedPage, ChapterRead, ClassificationPage,
  ContentsPage, CreditPage, DiscussionPage, HistoryKind, HistoryPage, Loaded, Progress, RatingRead,
  ReadFailure, RealmHeader, Reviewer, ReviewPage, ReviewQuery, RecipeWorkPage, HubWorkPage,
  VersionPage, WorkHeader, WorkStats }
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
export const reader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const identity = token ? await sessionAgentRead() : null;
  const state = identity?.kind === 'ready' ? identity.state : null;
  const acting = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject ?? undefined : undefined;
  return { main: mainApiWithToken(acting ? token : undefined), actingSubject: acting, signedIn: Boolean(token),
    identityUnavailable: identity?.kind === 'unavailable' };
});

/** Main ranks rating populations by current votes and supplies the reader-community flag. */
export const readRatingPopulations = cache(async (target: string, locale: UiLocale, client?: SuppliedClient): Promise<Loaded<ListPage<RatingPopulation>>> => {
  const { main, actingSubject } = client ?? await reader();
  try { return { ok: true, data: await discoveryApi(main, locale, actingSubject)
    .populations(idOf(target) ? target : iriOf(target), { limit: 20 }) }; }
  catch (error) { return error instanceof BrowseReadError
    ? refusedRead({ status: error.status, value: error.problem }) : { ok: false, failure: 'unavailable' }; }
});

/** The session Agent the page reads as, for client components that write as it (reading progress). */
export async function readingAgent(client?: SuppliedClient): Promise<{ signedIn: boolean; actingSubject: string | null }> {
  const { signedIn, actingSubject } = client ?? await reader();
  return { signedIn: Boolean(signedIn), actingSubject: actingSubject ?? null };
}

export { failureOf };

export { settle, settleNullable, type Answer } from './books-edition-page.read.ts';

/**
 * The survivor a merged Work's address reports in its optional `resolution`, as a Work UUID; null when the
 * answer carries none (the Work was not merged, or Main predates reporting it), which reads as today.
 */
export function mergedSurvivor(answer: unknown): string | null {
  const resolution = (answer as { resolution?: { state?: unknown; survivor?: unknown } } | null)?.resolution;
  return resolution?.state === 'merged' && typeof resolution.survivor === 'string' ? idOf(resolution.survivor) : null;
}

export type ResolvedRef =
  | { kind: 'work'; id: string }
  /** The alias was renamed, or its Work merged into another: the page moves to the current ref. */
  | { kind: 'moved'; key: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/** Retained names and merged identities use Main's current canonical key. */
export function workRefFromAddress(address: ResolvedAddress): ResolvedRef {
  // Main's summary-derived canonical address already selects a merged Work's
  // survivor and current name. Keep it intact instead of taking another UUID hop.
  return mergedSurvivor(address) || address.state === 'redirect'
    ? { kind: 'moved', key: addressKey(address.canonical) }
    : { kind: 'work', id: address.holder.slice(-36) };
}

/** A `/w/{ref}` segment to a Work UUID. Slugs never become alternate Work identities. */
export const resolveWorkRef = cache(async (ref: WorkRef): Promise<ResolvedRef> => {
  if (ref.kind === 'id') return { kind: 'work', id: ref.id };
  const resolved = await resolveAddress('work', ref.key, await requestLocale());
  if (resolved.kind !== 'resolved')
    return { kind: resolved.kind === 'unavailable' ? 'unavailable' : 'missing' };
  return workRefFromAddress(resolved.data);
});

export const readWorkHeader = cache(async (id: string, _locale: UiLocale, client?: SuppliedClient): Promise<Loaded<WorkHeader>> => {
  return booksEditionReads(client ?? await reader()).readWorkHeader(id);
});

/**
 * A Work's recipe section, one page from the link its `entity-page-v1` projection gave.
 * That page already spans sections. A thrown or failed call is this region's failure and
 * does not reject the Work page. A later page is a separate view.
 */
export async function readRecipeWorkPage(href: string, servings?: number): Promise<Loaded<RecipeWorkPage | null>> {
  try {
    const { main, actingSubject } = await reader();
    return recipeReadingReads({ main, actingSubject }).readRecipe(href, servings === undefined ? {} : { servings });
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** A Work's prompt or skill section, read from the link its projection gave. */
export async function readHubWorkPage(href: string): Promise<Loaded<HubWorkPage | null> | null> {
  if (operationOpen('getV1HubWorksById', await readPlatformAccess())) {
    const { main, actingSubject } = await reader();
    try {
      const answer = await followHref<HubWorkPage | null>(main, href, { actingSubject })();
      const { error } = answer;
      // The grant may have been revoked after the request's access summary was read.
      if (error && platformClosed(error.status, error.value)) return null;
      return settleNullable(async () => answer);
    } catch { return { ok: false, failure: 'unavailable' }; }
  }
  return null;
}

/** A chapter Post with the Books that place it, as Main's Post read gives them. */
export type PostRead = NonNullable<Awaited<ReturnType<ReturnType<ReturnType<typeof mainApiWithToken>['v1']['posts']>['get']>>['data']>;

/** One chapter Post as its reader may read it: its title, publisher and the Books that use it. */
export const readPost = cache(async (id: string, locale: UiLocale): Promise<Loaded<PostRead>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.posts({ id }).get({ query: { language: locale, actingSubject } }));
});

/**
 * Where a chapter Post is read in one named Book, for an address that carries both (`/w/{book}/read/{post}`);
 * null when that Book does not use the Post or the reader may not read it.
 */
export async function postPlaceInBook(post: string, book: string, locale: UiLocale, language?: string):
  Promise<string | null> {
  const read = await readPost(post, locale);
  return read.ok && read.data.placements.some(placement => idOf(placement.book) === book)
    ? postPlaceHref(read.data.placements, book, language) : null;
}

export type WorkResolution =
  | { kind: 'work'; id: string; header: WorkHeader }
  | { kind: 'moved'; key: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

/**
 * The Work behind a `/w/{ref}` page, shared by its layout, views and
 * metadata. Metadata reads this directly: vinext streams metadata, so a
 * `notFound()` thrown there would answer 200. Former chapter addresses move
 * to their reader place in the address edge before any page renders.
 */
export const resolveWork = cache(async (ref: string, locale: UiLocale): Promise<WorkResolution> => {
  // Reuse the charged address miss or live owner refusal for metadata and every view.
  if ((await headers()).get(WORK_MISSING_HEADER) === '1') return { kind: 'missing' };
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
 * renamed alias moves to the current one; when Main cannot answer, the page
 * says the Work is unavailable rather than pretending it does not exist. A
 * chapter's old Work address is handled by the address edge.
 */
export async function loadWork(ref: string, locale: UiLocale):
  Promise<{ ok: true; id: string; header: WorkHeader } | { ok: false }> {
  const work = await resolveWork(ref, locale);
  if (work.kind === 'missing') notFound();
  if (work.kind === 'moved') permanentRedirect(localizedPath(workHref(work.key), locale));
  return work.kind === 'work' ? { ok: true, id: work.id, header: work.header } : { ok: false };
}

export const readReleases = cache(async (id: string, client?: SuppliedClient) => {
  return booksEditionReads(client ?? await reader()).readReleases(id);
});

/** The saved release has an exact address independent of the inventory's current page. */
export const readEditionRelease = cache(async (id: string, release: string, client?: SuppliedClient) =>
  booksEditionReads(client ?? await reader()).readEditionRelease(id, release));

/** A saved realization is resolved at its exact retained revision. */
export const readEditionRealization = cache(async (id: string, realization: string, revision: string, client?: SuppliedClient) =>
  booksEditionReads(client ?? await reader()).readEditionRealization(id, realization, revision));

export const readCredits = cache(async (id: string, client?: SuppliedClient): Promise<Loaded<CreditPage>> => {
  const { main, actingSubject } = client ?? await reader();
  return booksEditionReads({ main, actingSubject }).readCredits(id);
});

export const readAdoptions = cache(async (id: string, _locale: UiLocale, client?: SuppliedClient): Promise<Loaded<AdoptionPage>> => {
  const { main, actingSubject } = client ?? await reader();
  return booksEditionReads({ main, actingSubject }).readAdoptions(id);
});

export const readRealm = cache(async (realm: string, _locale: UiLocale, client?: SuppliedClient): Promise<Loaded<RealmHeader>> => {
  const { main, actingSubject } = client ?? await reader();
  return settle(() => main.v1.realms({ realm }).get({ query: { actingSubject } }));
});

/** Mine needs a signed-in person acting as an Agent; say which step is missing before asking Main. */
async function scopeReader(scope: WorkScope, client?: SuppliedClient) {
  const current = client ?? await reader();
  if (scope.kind !== 'mine' || current.actingSubject) return { ...current, failure: null };
  return { ...current, failure: (current.signedIn ? 'identity' : 'sign-in') as ReadFailure };
}

export const readClassifications = cache(async (id: string, _locale: UiLocale, scope: WorkScope, client?: SuppliedClient):
  Promise<Loaded<ClassificationPage>> => {
  const { main, actingSubject } = client ?? await reader();
  return booksEditionReads({ main, actingSubject }).readClassifications(id, scope);
});

/**
 * The rating summary for one scope. Main never picks a question when several
 * Contexts exist, so the page does, visibly: the one in the URL, else the
 * first Main lists, and it names the Context it shows.
 */
export const readRatings = cache(async (id: string, scope: WorkScope, contextId: string | undefined, client?: SuppliedClient):
  Promise<Loaded<RatingRead>> => {
  const { main, actingSubject, failure } = await scopeReader(scope, client);
  if (failure) return { ok: false, failure };
  return readAnimeRelationsRatings({ main, actingSubject }, id, scope, contextId);
});

export async function readVersions(id: string, _locale: UiLocale, filter: VersionQuery, client?: SuppliedClient): Promise<Loaded<VersionPage>> {
  const { main, actingSubject } = client ?? await reader();
  return settle(async () => {
    const result=await main.v1.query.post({profile:'template-query-v1',query:'https://rezics.com/query/work-versions',revision:1,
      parameters:{roots:[iriOf(id)],kind:filter.kind,contentLanguage:filter.language},presentation:{actingSubject},cursor:filter.cursor});
    return {error:result.error,data:result.data?.result?.profile==='template-result-v1' && result.data.result.query==='https://rezics.com/query/work-versions' ? result.data.result:null};
  },filter.cursor);
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
  return settle(() => main.v1.resources({ resource: id }).discussion.get({ query: { actingSubject,
    realm: realm ? iriOf(realm) : undefined, cursor } }), cursor);
}

/** Works an Agent is credited on, newest first, for "More by" on a Work page. */
export const readAgentWorks = cache(async (agent: string, _locale: UiLocale, client?: SuppliedClient): Promise<Loaded<AgentWorksPage>> => {
  const { main, actingSubject } = client ?? await reader();
  return settle(() => main.v1.agents({ id: agent.slice(-36) }).works.get({ query: { actingSubject,
    limit: 12 } }));
});

/**
 * The numbers under the header's rating: people whose public library has the
 * Work on Currently reading, and the reviews answering `context`, everyone's
 * rating question the header shows.
 */
export const readWorkStats = cache(async (id: string, context: string | undefined, client?: SuppliedClient): Promise<Loaded<WorkStats>> => {
  return readAnimeRelationsStats(client ?? await reader(), id, context);
});

/**
 * Works this one's readers also enjoyed, or similar ones when too few have
 * read it, each card saying which (`basis`). One page of twelve: three pages
 * of the row on a wide screen.
 */
export const readAlsoEnjoyed = cache(async (id: string, _locale: UiLocale, client?: SuppliedClient): Promise<Loaded<AlsoEnjoyedPage>> => {
  const { main, actingSubject } = client ?? await reader();
  return booksEditionReads({ main, actingSubject }).readAlsoEnjoyed(id);
});

/** A page of this Work's reviews for one rating Context; the reader's own comes first on page one. */
export async function readReviews(id: string, query: Omit<ReviewQuery, 'actingSubject'>, client?: SuppliedClient): Promise<Loaded<ReviewPage>> {
  const { main, actingSubject } = client ?? await reader();
  return settle(() => main.v1.resources({ resource: id }).reviews.get({ query: { ...query, actingSubject } }), query.cursor);
}

/** An Agent's public name and handle, once per request, for reviews and credits Main names by IRI. */
export const readReviewer = cache(async (agent: string, client?: SuppliedClient): Promise<Reviewer | null> => {
  const { main, actingSubject } = client ?? await reader();
  const profile = await settle(() => main.v1.agents({ id: agent.slice(-36) }).get({ query: { actingSubject } }));
  return profile.ok ? { name: profile.data.displayName, handle: profile.data.handle } : null;
});

/**
 * The reader's shelf status and own ratings for this Work. Null when they act
 * as no Agent or Main denies that Agent a reader library; empty when Main could
 * not answer, so the controls read it again in the browser.
 */
export const readReaderState = cache(async (id: string, client?: SuppliedClient): Promise<ReaderSeed | null> => {
  const { main, actingSubject } = client ?? await reader();
  if (!actingSubject) return null;
  const state = await settle(() => main.v1.works({ id })['reader-state'].get({ query: { actingSubject } }));
  if (state.ok) return { [state.data.work]: readerEntry(state.data) };
  return state.failure === 'sign-in' ? null : {};
});

export const readAgentCredits = cache(async (id: string, client?: SuppliedClient): Promise<Loaded<AgentCreditPage>> => {
  const { main, actingSubject } = client ?? await reader();
  return booksEditionReads({ main, actingSubject }).readAgentCredits(id);
});

/** A caller-supplied Main client. Omitted, reads use the request-cached host client. */
export type SuppliedClient = { main: MainClient; actingSubject?: string; signedIn?: boolean };

/** One level of the Main Version's table of contents: a group's children, or the top level. */
export async function readContents(id: string, query: ContentsQuery, client?: SuppliedClient): Promise<Loaded<ContentsPage>> {
  return readSuppliedContents(client ?? await reader(), id, query);
}

/**
 * The language of the one text a Work without contents is read as: the one
 * Main selects for the reader's language (`selected`), else the Main
 * Version's selected text in any language, as Main's Versions read marks it
 * (English first, as Main picks). Null when the Work has no selected text.
 */
export const oneTextLanguage = cache(async (id: string, locale: UiLocale, selected: string | null, client?: SuppliedClient):
  Promise<string | null> => {
  if (selected) return selected;
  const versions = await readVersions(id, locale, { kind: 'text-variant' }, client);
  const languages = versions.ok ? versions.data.items.filter(item => item.selected).map(item => item.language) : [];
  return languages.find(language => language === 'en') ?? languages.sort()[0] ?? null;
});

/**
 * Where "Read" leads. A reader already in the Work continues at the next
 * chapter they have not read, as Main's Continue read gives it; anyone else
 * starts at chapter 1, found by descending the first parts of the contents
 * (at most three levels, one page each). A Work with no contents but a
 * selected text is read as that one text. Null when the Work has nothing to
 * read. A refused contents read remains unavailable, with its owner refusal.
 */
export const readStart = cache(async (id: string, work: string, locale: UiLocale, selected: string | null,
  client?: SuppliedClient): Promise<ReadStart> => {
  return readSuppliedStart(client ?? await reader(), id, work, () => oneTextLanguage(id, locale, selected, client));
});

/**
 * Where Main says the reader stands in a Work: its composition's next part, or a standalone Work's own status
 * (G-835). Nothing is derived here. Signed out, or without an acting Agent, there is nothing to read.
 */
export const readProgressSummary = cache(async (id: string, language?: string, client?: SuppliedClient): Promise<Loaded<ProgressSummary>> => {
  return booksEditionReads(client ?? await reader()).readProgressSummary(id, language);
});

/** The reader's private edition choice for a Work: a language and optionally one realization or release. */
export const readEditionPreference = cache(async (id: string, client?: SuppliedClient): Promise<Loaded<EditionPreference | null>> => {
  return booksEditionReads(client ?? await reader()).readEditionPreference(id);
});

export type ReadStart =
  | { kind: 'start' | 'continue'; href: string; chapter: string | null }
  | { kind: 'contents' }
  | ({ kind: 'unavailable' } & Extract<Loaded<never>, { ok: false }>)
  | null;

/**
 * The text a Work is read as when it has no contents: its Main Version's selected publication, in the
 * named language or the one Main selects.
 */
export const readText = cache(async (mainVersion: string, language: string | undefined) => {
  return booksLanguageReads(await reader()).readText(mainVersion, language);
});

/** The standalone reader reuses the resolved header and request-cached selected text. */
export const readBooksLanguagePage = cache(async (id: string, header: WorkHeader, language: string | null | undefined) =>
  booksLanguageReads(await reader()).readPage(id, { header, language, readText }));

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
