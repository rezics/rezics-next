import { cookies } from 'next/headers';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { type ReaderSeed, readReaderSeed } from '../catalogue/reader-store.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { type AuthorFollowState, type AuthorWorksPage, type ExternalAuthor, failureOf, type Loaded } from './types.ts';

// Server reads for `/authors/open-library/{id}`. Each returns a `Loaded`
// result instead of throwing. Reads are cached per request: the page and its
// metadata share one Main call.

/**
 * Who reads. A signed-in person whose session Agent is eligible reads as that
 * Agent, so shelf buttons know their shelves; anyone else reads publicly.
 */
export const authorReader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject ?? undefined : undefined;
  return { signedIn: Boolean(token), actingSubject, main: mainApiWithToken(actingSubject ? token : undefined),
    /** Cover bytes go through the BFF, which sends the token, so Main needs the Agent too. */
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '' };
});

type Answer<T> = { data: T | null; error: { status: number } | null };

/** One Main read as a `Loaded` result; a first page moved by the graph starts again once, as Main asks. */
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

/** The author, their facts and totals, and their first `limit` Works (most rated first). */
export const readOpenLibraryAuthor = cache(async (key: string, _locale: UiLocale, limit: number):
  Promise<Loaded<ExternalAuthor>> => {
  const { main, actingSubject } = await authorReader();
  return settle(() => main.v1.authors['open-library']({ author: key.slice('/authors/'.length) })
    .get({ query: { actingSubject, limit } }));
});

/** One page of the author's Works, in the author page's order. */
export const readOpenLibraryAuthorWorks = cache(async (key: string, _locale: UiLocale, limit: number, cursor?: string):
  Promise<Loaded<AuthorWorksPage>> => {
  const { main, actingSubject } = await authorReader();
  return settle(() => main.v1.authors['open-library']({ author: key.slice('/authors/'.length) }).works
    .get({ query: { actingSubject, limit, cursor } }), cursor);
});

/**
 * Followers, and as a signed-in reader whether they follow the author, for
 * the follow button. Main shows everyone the same count and never who.
 */
export const readAuthorFollow = cache(async (key: string, _locale: UiLocale): Promise<Loaded<AuthorFollowState>> => {
  const { main, actingSubject } = await authorReader();
  return settle(() => main.v1.authors['open-library']({ author: key.slice('/authors/'.length) }).follow
    .get({ query: { actingSubject } }));
});

/** The reader's shelf state for the Works on the page, so shelf buttons render settled. */
export async function readReaderState(works: readonly string[]): Promise<ReaderSeed | null> {
  const { main, actingSubject } = await authorReader();
  if (!actingSubject || !works.length) return actingSubject ? {} : null;
  return readReaderSeed(main, actingSubject, works);
}
