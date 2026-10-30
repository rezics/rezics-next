import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import { readLibraryResult } from '../library/reads';
import { MediaProblem } from '../media/kernel';

export type CollectionPrivacyFailure = 'closed' | 'forbidden' | 'unavailable';
export type CollectionPrivacyRead<T> = { ok: true; value: T } | { ok: false; reason: CollectionPrivacyFailure };

/** Only the existing native admission refusals withdraw the last readable presentation. */
export function isCollectionPrivacyReadRefusal(reason: CollectionPrivacyFailure): reason is 'closed' | 'forbidden' {
  return reason === 'closed' || reason === 'forbidden';
}

/** Preserve native admission failures across the private server-function boundary. */
export function readCollectionPrivacyResult<T>(result: { data?: T | null; error?: unknown; status?: number }): T {
  const error = result.error;
  const body = error && typeof error === 'object' && 'value' in error ? error.value : error;
  if (isPlatformClosedProblem(result.status, body)) throw new Error('Collection privacy closed');
  if (result.status === 401 || result.status === 403) throw new Error('Collection privacy forbidden');
  return readLibraryResult(result);
}

export function collectionPrivacyFailure(error: unknown): CollectionPrivacyFailure {
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
    return { ok: false, reason: collectionPrivacyFailure(error) };
  }
}
