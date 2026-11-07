import { isPlatformClosedError, isPlatformClosedProblem } from './ports/vocabulary';
import { readLibraryResult } from '../library/settings-adapter';
import { MediaProblem } from '../media/kernel';
import type { NativePreferenceFailure } from './preferences';

export type CollectionPrivacyFailure = 'closed' | 'forbidden' | 'unavailable';
export type CollectionPrivacyRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: CollectionPrivacyFailure; failure?: NativePreferenceFailure };

class CollectionPrivacyReadError extends Error {
  constructor(
    readonly reason: CollectionPrivacyFailure,
    readonly failure: NativePreferenceFailure | undefined,
  ) {
    super(`Collection privacy ${reason}`);
  }
}

/** Only the existing native admission refusals withdraw the last readable presentation. */
export function isCollectionPrivacyReadRefusal(reason: CollectionPrivacyFailure): reason is 'closed' | 'forbidden' {
  return reason === 'closed' || reason === 'forbidden';
}

/** Preserve native admission failures across the private server-function boundary. */
export function readCollectionPrivacyResult<T>(result: {
  data?: T | null;
  error?: unknown;
  status?: number;
  headers?: HeadersInit | undefined;
}): T {
  try {
    const error = result.error;
    const body = error && typeof error === 'object' && 'value' in error ? error.value : error;
    if (isPlatformClosedProblem(result.status, body)) throw new Error('Collection privacy closed');
    if (result.status === 401 || result.status === 403) throw new Error('Collection privacy forbidden');
    return readLibraryResult(result);
  } catch (error) {
    throw new CollectionPrivacyReadError(
      collectionPrivacyFailure(error),
      collectionPrivacyFailureMetadata(result.error, result.status, result.headers),
    );
  }
}

export function collectionPrivacyFailure(error: unknown): CollectionPrivacyFailure {
  if (error instanceof CollectionPrivacyReadError) return error.reason;
  if (isPlatformClosedError(error) || (error instanceof Error && error.message === 'Collection privacy closed'))
    return 'closed';
  if (error instanceof MediaProblem && (error.problem.status === 401 || error.problem.status === 403))
    return 'forbidden';
  return error instanceof Error && error.message === 'Collection privacy forbidden' ? 'forbidden' : 'unavailable';
}

export async function collectionPrivacyRead<T>(read: () => Promise<T>): Promise<CollectionPrivacyRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    const failure = collectionPrivacyFailureMetadata(error);
    return { ok: false, reason: collectionPrivacyFailure(error), ...(failure ? { failure } : {}) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Existing Settings failure projection, shared with the Collection privacy adapters. */
export function nativePreferenceFailureDetails(
  value: unknown,
  status?: number,
  headers?: HeadersInit,
): NativePreferenceFailure {
  const root = isRecord(value) ? value : undefined;
  const problem = root && isRecord(root.value) ? root.value : root && isRecord(root.problem) ? root.problem : root;
  const nativeStatus =
    status ??
    (root && typeof root.status === 'number'
      ? root.status
      : problem && typeof problem.status === 'number'
        ? problem.status
        : null);
  const retryAfter =
    (headers === undefined ? undefined : new Headers(headers).get('retry-after')) ??
    (value instanceof MediaProblem ? new Headers(value.headers).get('retry-after') : undefined) ??
    (root && typeof root.retryAfter === 'string' ? root.retryAfter : undefined);
  return {
    status: nativeStatus,
    ...(problem && typeof problem.code === 'string' ? { code: problem.code } : {}),
    ...(problem && typeof problem.retryable === 'boolean' ? { retryable: problem.retryable } : {}),
    ...(problem && typeof problem.request_id === 'string'
      ? { requestId: problem.request_id }
      : problem && typeof problem.requestId === 'string'
        ? { requestId: problem.requestId }
        : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

/** Sparse legacy errors retain their envelope; native problems and retry headers carry actual metadata. */
export function collectionPrivacyFailureMetadata(
  value: unknown,
  status?: number,
  headers?: HeadersInit,
): NativePreferenceFailure | undefined {
  if (value instanceof CollectionPrivacyReadError) return value.failure;
  const failure = nativePreferenceFailureDetails(value, status, headers);
  const root = isRecord(value) ? value : undefined;
  const problem =
    root && 'value' in root
      ? isRecord(root.value)
        ? root.value
        : undefined
      : root && isRecord(root.problem)
        ? root.problem
        : root;
  return value instanceof MediaProblem ||
    failure.retryAfter !== undefined ||
    failure.retryable !== undefined ||
    failure.requestId !== undefined ||
    (problem && typeof problem.status === 'number')
    ? failure
    : undefined;
}
