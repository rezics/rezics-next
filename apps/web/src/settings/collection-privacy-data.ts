import { isPlatformClosedError, isPlatformClosedProblem } from './ports/vocabulary';
import { readLibraryResult } from '../library/settings-adapter';
import type { NativePreferenceFailure } from './preferences';
import type { SettingsContentFailureReader } from './ports/content';

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
export function readCollectionPrivacyResult<T>(
  result: { data?: T | null; error?: unknown; status?: number; headers?: HeadersInit | undefined },
  mediaFailure: SettingsContentFailureReader,
): T {
  try {
    const error = result.error;
    const body = error && typeof error === 'object' && 'value' in error ? error.value : error;
    if (isPlatformClosedProblem(result.status, body)) throw new Error('Collection privacy closed');
    if (result.status === 401 || result.status === 403) throw new Error('Collection privacy forbidden');
    return readLibraryResult(result);
  } catch (error) {
    throw new CollectionPrivacyReadError(
      collectionPrivacyFailure(error, mediaFailure),
      collectionPrivacyFailureMetadata(result.error, result.status, result.headers, mediaFailure),
    );
  }
}

export function collectionPrivacyFailure(
  error: unknown,
  mediaFailure: SettingsContentFailureReader = () => undefined,
): CollectionPrivacyFailure {
  if (error instanceof CollectionPrivacyReadError) return error.reason;
  if (isPlatformClosedError(error) || (error instanceof Error && error.message === 'Collection privacy closed'))
    return 'closed';
  const content = mediaFailure(error);
  if (content?.status === 401 || content?.status === 403) return 'forbidden';
  return error instanceof Error && error.message === 'Collection privacy forbidden' ? 'forbidden' : 'unavailable';
}

export async function collectionPrivacyRead<T>(
  read: () => Promise<T>,
  mediaFailure: SettingsContentFailureReader,
): Promise<CollectionPrivacyRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    const failure = collectionPrivacyFailureMetadata(error, undefined, undefined, mediaFailure);
    return {
      ok: false,
      reason: collectionPrivacyFailure(error, mediaFailure),
      ...(failure ? { failure } : {}),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Settings projects Content failures into the native preference envelope at this adapter boundary. */
export function nativePreferenceFailureDetails(
  value: unknown,
  status?: number,
  headers?: HeadersInit,
  mediaFailure: SettingsContentFailureReader = () => undefined,
): NativePreferenceFailure {
  const root = isRecord(value) ? value : undefined;
  const content = mediaFailure(value);
  const problem =
    content?.problem ??
    (root && isRecord(root.value) ? root.value : root && isRecord(root.problem) ? root.problem : root);
  const nativeStatus =
    status ??
    content?.status ??
    (root && typeof root.status === 'number'
      ? root.status
      : problem && typeof problem.status === 'number'
        ? problem.status
        : null);
  const retryAfter =
    (headers === undefined ? undefined : new Headers(headers).get('retry-after')) ??
    (content?.headers === undefined ? undefined : new Headers(content.headers).get('retry-after')) ??
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
  mediaFailure: SettingsContentFailureReader = () => undefined,
): NativePreferenceFailure | undefined {
  if (value instanceof CollectionPrivacyReadError) return value.failure;
  const content = mediaFailure(value);
  const failure = nativePreferenceFailureDetails(value, status, headers, mediaFailure);
  const root = isRecord(value) ? value : undefined;
  const problem =
    root && 'value' in root
      ? isRecord(root.value)
        ? root.value
        : undefined
      : root && isRecord(root.problem)
        ? root.problem
        : root;
  return content ||
    failure.retryAfter !== undefined ||
    failure.retryable !== undefined ||
    failure.requestId !== undefined ||
    (problem && typeof problem.status === 'number')
    ? failure
    : undefined;
}
