import type { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

// Main's discovery and Realm read shapes (`services/main/src/modules/discovery/contract.ts`),
// taken from the typed Eden client so a contract change breaks this build.

/** The Eden client for Main: `mainApi()` on the server, `browserMainApi()` in the browser. */
export type MainClient = ReturnType<typeof treaty<MainApp>>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Discovery = MainClient['v1']['works']['get'];

export type DiscoveryQuery = NonNullable<NonNullable<Parameters<Discovery>[0]>['query']>;
export type DiscoveryPage = Ok<Discovery>;
export type DiscoveryItem = DiscoveryPage['items'][number];
export type DiscoveryRating = NonNullable<DiscoveryItem['rating']>;
export type ClassificationReason = NonNullable<DiscoveryItem['match']['classification']>;
export type WorkName = DiscoveryItem['title'];
export type WorkCover = DiscoveryItem['cover'];
export type RealmHeader = Ok<ReturnType<MainClient['v1']['realms']>['get']>;

/**
 * Why a read has no data. Each shelf shows its own; the rest of the page stays.
 * `unbuilt` is Main's 503 for a scope whose discovery generation is not active;
 * `stale` is its 409 on a first page, when the active generation predates a
 * write and no operator has rebuilt it; `moved` is a 409 on a later page.
 */
export type ReadFailure = 'unbuilt' | 'stale' | 'moved' | 'invalid' | 'unsupported' | 'sign-in' | 'missing' | 'budget'
  | 'unavailable';

export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

export function failureOf(status: number, code?: string): ReadFailure {
  if (status === 404) return 'missing';
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 409) return 'moved';
  if (code === 'unsupported_query_shape' || code === 'unsupported_query_source') return 'unsupported';
  if (status === 400) return 'invalid';
  if (status === 422) return 'budget';
  if (status === 503 && code === 'discovery_unavailable') return 'unbuilt';
  return 'unavailable';
}

/** Main's problem code from an Eden error value, when it sent one. */
export function problemCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code : undefined;
}
