import type { NativePreferenceFailure } from './preferences';
import type { SettingsContentFailureReader } from './ports/content';

export type EditableProfileFailure = NativePreferenceFailure & { status: number };

export class EditableProfileReadError extends Error {
  constructor(
    readonly status: number,
    readonly failure?: EditableProfileFailure,
  ) {
    super('Profile unavailable');
  }
}

/** Only a native problem envelope and actual response headers supply optional metadata. */
export function nativeProfileFailure(status: number, body?: unknown, headers?: HeadersInit): EditableProfileFailure {
  const problem = body && typeof body === 'object' ? body : undefined;
  const native =
    problem &&
    'type' in problem &&
    typeof problem.type === 'string' &&
    'title' in problem &&
    typeof problem.title === 'string' &&
    'code' in problem &&
    typeof problem.code === 'string'
      ? problem
      : undefined;
  const retryAfter = new Headers(headers).get('retry-after');
  return {
    status,
    ...(native ? { code: native.code as string } : {}),
    ...(native && 'retryable' in native && typeof native.retryable === 'boolean'
      ? { retryable: native.retryable }
      : {}),
    ...(native && 'request_id' in native && typeof native.request_id === 'string'
      ? { requestId: native.request_id }
      : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

export function profileReadFailure(
  error: unknown,
  mediaFailure: SettingsContentFailureReader,
): EditableProfileFailure | undefined {
  if (error instanceof EditableProfileReadError) return { ...error.failure, status: error.status };
  const failure = mediaFailure(error);
  if (failure) return nativeProfileFailure(failure.status, failure.problem, failure.headers);
  return undefined;
}
