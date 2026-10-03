import type { MainClient } from '../discover/types.ts';
import type { CanonicalAddress } from '@rezics/model/address';

// Main's profile, credited-Work, public shelf and follow reads
// (`services/main/src/routes/profiles.ts`, `library.ts`, `follows.ts`), taken
// from the typed Eden client so a contract change breaks this build.
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Agent = ReturnType<MainClient['v1']['agents']>;

export type AgentProfile = Omit<Ok<ReturnType<MainClient['v1']['handles']>['get']>, 'address'> & {
  address?: CanonicalAddress;
};
export type AgentKind = AgentProfile['kind'];
export type AgentWorksPage = Ok<Agent['works']['get']>;
export type CreditedWork = AgentWorksPage['items'][number];
export type CreditRole = CreditedWork['attribution'][number]['role'];
export type PublicShelves = Ok<Agent['shelves']['get']>;
export type ShelfStatus = PublicShelves['statusShelves'][number]['status'];
export type PublicShelfPage = Ok<ReturnType<Agent['shelves']['status']>['works']['get']>;
export type ShelfCard = PublicShelfPage['items'][number]['card'];
export type FollowState = Ok<ReturnType<MainClient['v1']['follows']>['get']>;
export type FollowerCount = FollowState['followers'];

/**
 * Why a region has no data. Each region shows its own and the rest of the
 * profile stays: `missing` is Main's 404 (no such Agent, or its shelves are
 * not public), `moved` a 409 under a cursor, `unavailable` anything else.
 */
export type ReadFailure = 'missing' | 'sign-in' | 'moved' | 'invalid' | 'unavailable';

export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number): ReadFailure {
  if (status === 404 || status === 410) return 'missing';
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 409) return 'moved';
  if (status === 400 || status === 422) return 'invalid';
  return 'unavailable';
}

/**
 * A status shelf's counts and its first Works, as the profile shows it. The
 * owner of a non-public library reads their own through `/v1/me/shelves`,
 * which the page marks as visible only to them.
 */
export interface ShelfSummary {
  status: ShelfStatus;
  count: number;
  works: Loaded<ShelfCard[]>;
}

/** What the profile can say about a person's library. */
export type LibraryView =
  | { kind: 'shelves'; own: boolean; shelves: ShelfSummary[] }
  /** Visible to followers or to no one; the profile says so without naming a count. */
  | { kind: 'private'; visibility: 'followers' | 'private' }
  | { kind: 'failed'; failure: ReadFailure };
