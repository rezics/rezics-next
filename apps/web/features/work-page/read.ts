import { cookies } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { type ContentsQuery, iriOf, mainScope, parseWorkRef, type VersionQuery, type WorkRef, type WorkScope, workHref } from './route.ts';
import type { AdoptionPage, AgentCreditPage, ChapterRead, ClassificationPage, ContentsPage, CreditPage,
  DiscussionPage, HistoryKind, HistoryPage, Loaded, Progress, RatingContextPage, RatingRead, ReadFailure,
  RealmHeader, VersionPage, WorkHeader } from './types.ts';

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

export function failureOf(status: number): ReadFailure {
  if (status === 404 || status === 410) return 'missing';
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 409) return 'moved';
  if (status === 400) return 'invalid';
  if (status === 422) return 'budget';
  return 'unavailable';
}

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

export const readWorkHeader = cache(async (id: string, locale: UiLocale): Promise<Loaded<WorkHeader>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).get({ query: { language: locale, actingSubject } }));
});

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
 * says the Work is unavailable rather than pretending it does not exist.
 */
export async function loadWork(ref: string, locale: UiLocale):
  Promise<{ ok: true; id: string; header: WorkHeader } | { ok: false }> {
  const work = await resolveWork(ref, locale);
  if (work.kind === 'missing') notFound();
  if (work.kind === 'moved') permanentRedirect(workHref(work.slug));
  return work.kind === 'work' ? { ok: true, id: work.id, header: work.header } : { ok: false };
}

export const readCredits = cache(async (id: string): Promise<Loaded<CreditPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).credits.get({ query: { actingSubject } }));
});

export const readAdoptions = cache(async (id: string, locale: UiLocale): Promise<Loaded<AdoptionPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).adoptions.get({ query: { language: locale, actingSubject } }));
});

export const readRealm = cache(async (realm: string, locale: UiLocale): Promise<Loaded<RealmHeader>> => {
  const { main } = await reader();
  return settle(() => main.v1.realms({ realm }).get({ query: { language: locale } }));
});

/** Mine needs a signed-in person acting as an Agent; say which step is missing before asking Main. */
async function scopeReader(scope: WorkScope) {
  const current = await reader();
  if (scope.kind !== 'mine' || current.actingSubject) return { ...current, failure: null };
  return { ...current, failure: (current.signedIn ? 'identity' : 'sign-in') as ReadFailure };
}

export const readClassifications = cache(async (id: string, locale: UiLocale, scope: WorkScope):
  Promise<Loaded<ClassificationPage>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).classifications.get({
    query: { language: locale, actingSubject, ...mainScope(scope) } }));
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

export async function readVersions(id: string, locale: UiLocale, filter: VersionQuery): Promise<Loaded<VersionPage>> {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.works({ id }).versions.get({ query: { language: locale, actingSubject,
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
