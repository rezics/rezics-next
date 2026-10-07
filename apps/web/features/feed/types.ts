import type { browserMainApi } from '../api/browser.ts';
import { platformClosed } from '../api/platform-access.ts';

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
 * (yet), `closed` an operation the platform has not opened for this viewer (Main's `platform_closed`:
 * callers render it as absent, never as an error), `offline` a request that never
 * reached Main, `unavailable` a response from Main that is still a failure (a 500).
 */
export type ReadFailure = 'moved' | 'invalid' | 'sign-in' | 'missing' | 'budget' | 'closed' | 'offline' | 'unavailable';

export type Loaded<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure; reference?: string };

/** Which sentence a failure may use. `absent` is not an error. */
export type FailureNotice = 'absent' | 'offline' | 'server' | 'missing' | 'denied' | 'moved' | 'budget';

export function readFailureNotice(failure: ReadFailure): FailureNotice {
  switch (failure) {
    case 'closed': return 'absent';
    case 'offline': return 'offline';
    case 'missing': return 'missing';
    case 'sign-in': return 'denied';
    case 'moved': case 'invalid': return 'moved';
    case 'budget': return 'budget';
    case 'unavailable': return 'server';
  }
}

/** Words for one failure. `reference` means the server sentence may quote an id the response carried. */
export interface FailureCopy {
  failedTitle: string;
  offline: string;
  server: string;
  missingTitle: string;
  missingBody: string;
  deniedTitle: string;
  deniedBody: string;
  movedTitle: string;
  movedBody: string;
  budget: string;
}

export type FailureText =
  | { kind: 'absent' }
  | { kind: 'shown'; title: string; description: string; action: 'retry' | 'restart' | 'sign-in' | 'none'; reference: boolean };

export function failureText(failure: ReadFailure, copy: FailureCopy): FailureText {
  switch (readFailureNotice(failure)) {
    case 'absent': return { kind: 'absent' };
    case 'missing': return { kind: 'shown', title: copy.missingTitle, description: copy.missingBody, action: 'none', reference: false };
    case 'denied': return { kind: 'shown', title: copy.deniedTitle, description: copy.deniedBody, action: 'sign-in', reference: false };
    case 'moved': return { kind: 'shown', title: copy.movedTitle, description: copy.movedBody, action: 'restart', reference: false };
    case 'budget': return { kind: 'shown', title: copy.failedTitle, description: copy.budget, action: 'retry', reference: false };
    case 'offline': return { kind: 'shown', title: copy.failedTitle, description: copy.offline, action: 'retry', reference: false };
    case 'server': return { kind: 'shown', title: copy.failedTitle, description: copy.server, action: 'retry', reference: true };
  }
}

export function failureOf(status: number, body?: unknown): ReadFailure {
  if (platformClosed(status, body)) return 'closed';
  if (status === 0) return 'offline';
  if (status === 404) return 'missing';
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 409) return 'moved';
  if (status === 400) return 'invalid';
  if (status === 422) return 'budget';
  return 'unavailable';
}

/** A support id the response itself carried. Problem codes are not ids. */
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9.-]{3,63}$/;

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  if (Array.isArray(headers)) {
    const found = headers.find((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === name);
    return found ? String(found[1]) : null;
  }
  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const key = Object.keys(record).find((item) => item.toLowerCase() === name);
    return key && typeof record[key] === 'string' ? record[key] : null;
  }
  return null;
}

export function referenceOf(body: unknown, headers?: unknown): string | undefined {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  for (const key of ['reference', 'requestId', 'traceId'] as const) {
    const value = record?.[key];
    if (typeof value === 'string' && REFERENCE.test(value)) return value;
  }
  if (headers) {
    for (const name of ['x-request-id', 'x-correlation-id', 'x-rezics-request-id']) {
      const value = headerValue(headers, name);
      if (value && REFERENCE.test(value)) return value;
    }
    const trace = headerValue(headers, 'traceparent')?.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/);
    if (trace) return trace[1];
  }
  return undefined;
}

/** A failed read. The reference is kept only for a server failure that carried one. */
export function failedRead<F extends string>(failure: F, body?: unknown, headers?: unknown):
  { ok: false; failure: F; reference?: string } {
  if (failure !== 'unavailable') return { ok: false, failure };
  const reference = referenceOf(body, headers);
  return reference ? { ok: false, failure, reference } : { ok: false, failure };
}

/** The browser or the transport never got a response. A timeout is Main's, not the reader's connection. */
export function isOfflineError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'NetworkError';
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
    'UND_ERR_SOCKET', 'ConnectionClosed'].includes(code ?? '')) return true;
  if (/failed to fetch|networkerror|network request failed|load failed|connection (?:refused|lost|closed|reset)|socket (?:closed|hang up)|offline/i.test(error.message))
    return true;
  return error.cause !== undefined && isOfflineError(error.cause);
}

type Answer<T> = {
  data: T | null;
  error: { status: number; value: unknown } | null;
  headers?: unknown;
  response?: { headers?: unknown };
};

/** One Main read as `Loaded`, never a throw, so one region's failure stays in that region. */
export async function settle<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T>> {
  try {
    const answer = await call();
    if (answer.error) return failedRead(failureOf(answer.error.status, answer.error.value), answer.error.value,
      answer.headers ?? answer.response?.headers);
    return answer.data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data: answer.data };
  } catch (error) {
    return { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' };
  }
}

/** The UUID at the end of a REZICS IRI, as Main's path parameters take it. */
export function uuidOf(iri: string): string {
  return iri.slice(-36);
}
