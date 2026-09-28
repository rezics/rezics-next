import type { browserMainApi } from '../api/browser.ts';

// Main's home shapes (`services/main/src/modules/feed/contract.ts`, `feed/personal.ts`,
// `modules/follows`, `modules/continue`, `modules/onboarding`), taken
// from the typed Eden client so a contract change breaks this build.

/** The Eden client for Main: `mainApi()` on the server, `browserMainApi()` in the browser. */
export type MainClient = ReturnType<typeof browserMainApi>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type FeedRead = MainClient['v1']['feed']['get'];
type FollowsRead = MainClient['v1']['me']['follows']['get'];

export type FeedQuery = NonNullable<NonNullable<Parameters<FeedRead>[0]>['query']>;
export type FeedPage = Ok<FeedRead>;
export type FeedItem = FeedPage['items'][number];
export type FeedCard = FeedItem['card'];
export type FeedModelKind = FeedItem['kind'];
export type Avatar = FeedItem['target']['cover'];
export type Name = FeedItem['target']['title'];
export type Vote = FeedItem['vote'];
type FollowsPage = Ok<FollowsRead>;
export type FollowEntry = FollowsPage['items'][number];
export type FollowKind = FollowEntry['kind'];
export type FeedHead = Ok<MainClient['v1']['feed']['head']['get']>;
export type ContinueItem = Ok<MainClient['v1']['me']['continue']['get']>['items'][number];
export type OnboardingChoices = Ok<MainClient['v1']['onboarding']['choices']['get']>;
export type SuggestedFollow = Ok<MainClient['v1']['onboarding']['suggested-follows']['get']>['items'][number];
export type TrendingItem = Ok<MainClient['v1']['trending']['get']>['items'][number];
type FeedbackBody = Parameters<MainClient['v1']['me']['feed-feedback']['post']>[0];
export type FeedbackKind = FeedbackBody['kind'];
export type FeedbackStrength = FeedbackBody['strength'];

/**
 * Why a read has no data. Each region shows its own and the rest of the page
 * stays: `moved` is Main's 409 when the feed or follows changed under a cursor,
 * `sign-in` a refused or expired session, `missing` a read Main does not serve
 * (yet), `unavailable` anything else.
 */
export type ReadFailure = 'moved' | 'invalid' | 'sign-in' | 'missing' | 'budget' | 'unavailable';

export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number): ReadFailure {
  if (status === 404) return 'missing';
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 409) return 'moved';
  if (status === 400) return 'invalid';
  if (status === 422) return 'budget';
  return 'unavailable';
}

type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };

/** One Main read as `Loaded`, never a throw, so one region's failure stays in that region. */
export async function settle<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T>> {
  try {
    const { data, error } = await call();
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** The UUID at the end of a REZICS IRI, as Main's path parameters take it. */
export function uuidOf(iri: string): string {
  return iri.slice(-36);
}
