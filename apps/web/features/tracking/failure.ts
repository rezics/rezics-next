import { failedRead, failureOf, isOfflineError, type ReadFailure } from '../feed/types.ts';

/** Display categories coexist with the unmodified HTTP answer, including problem extensions. */
export type TrackingFailure<F extends string = ReadFailure> = {
  ok: false; failure: F; reference?: string; status?: number; problem?: unknown;
};
export type Loaded<T> = { ok: true; data: T } | TrackingFailure;

export function trackingFailure<F extends string>(failure: F, status?: number, problem?: unknown, headers?: unknown): TrackingFailure<F> {
  return { ...failedRead(failure, problem, headers), ...(status === undefined ? {} : { status, problem }) };
}

type Answer<T> = {
  data: T | null; error: { status: number; value: unknown } | null;
  headers?: unknown; response?: { status?: number; headers?: unknown };
};

/** Eden uses a synthetic 503 for a thrown fetch; it is not an HTTP answer. */
export function transportFailureOf(answer: Pick<Answer<unknown>, 'error' | 'response'>): TrackingFailure | null {
  return (answer.error?.value instanceof Error || answer.error?.value instanceof DOMException) && !answer.response
    ? { ok: false, failure: isOfflineError(answer.error.value) ? 'offline' : 'unavailable' } : null;
}

/** A 202 acknowledges pending work; it never supplies completed progress. */
export async function settle<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T>> {
  try {
    const answer = await call();
    const transport = transportFailureOf(answer);
    if (transport) return transport;
    const headers = answer.headers ?? answer.response?.headers;
    if (answer.error) return trackingFailure(failureOf(answer.error.status, answer.error.value), answer.error.status, answer.error.value, headers);
    if (answer.response?.status === 202) return trackingFailure('unavailable', 202, answer.data, headers);
    return answer.data === null ? trackingFailure('unavailable', answer.response?.status, answer.data, headers) : { ok: true, data: answer.data };
  } catch (error) {
    return { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' };
  }
}
