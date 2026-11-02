import { withProfileDeadline } from './profile-request-deadline';
import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { MediaProblem } from '../media/kernel';
import type { NativePreferenceFailure } from './preferences';

type ProfileRead = ReturnType<KernelClient['accounts']>['profile']['get'];
export type EditableProfile = NonNullable<Awaited<ReturnType<ProfileRead>>['data']>['profile'];

/** The private source uses the same server-held credential and account key as the existing PATCH. */
export type EditableProfileSource = {
  read: (authorization: string, accountId: string, signal?: AbortSignal) => Promise<EditableProfile>;
};

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

export function profileReadFailure(error: unknown): EditableProfileFailure | undefined {
  if (error instanceof EditableProfileReadError) return { ...error.failure, status: error.status };
  if (error instanceof MediaProblem) return nativeProfileFailure(error.problem.status, error.problem, error.headers);
  return undefined;
}

const dimension = v.pipe(v.number(), v.integer(), v.minValue(1));
const coordinate = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const fields = {
  id: v.string(),
  handle: v.nullable(v.string()),
  displayName: v.nullable(v.string()),
  bio: v.nullable(v.string()),
  links: v.pipe(v.array(v.strictObject({ label: v.string(), url: v.string() })), v.maxLength(5)),
  avatar: v.nullable(
    v.strictObject({
      media: v.string(),
      width: dimension,
      height: dimension,
      placeholder: v.strictObject({ thumbhash: v.string(), color: v.string() }),
      variants: v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: dimension })),
      focalPoint: v.nullable(v.strictObject({ x: coordinate, y: coordinate })),
      credit: v.null(),
    }),
  ),
  publicViews: v.strictObject({
    posts: v.boolean(),
    reviews: v.boolean(),
    collections: v.boolean(),
    realms: v.boolean(),
  }),
};
// Mirror the integrated route's closed actor/organization bodies, including Content's actual avatar summary.
const response = v.strictObject({
  profile: v.variant('kind', [
    v.strictObject({ ...fields, kind: v.literal('actor') }),
    v.strictObject({ ...fields, kind: v.literal('organization'), speakersListed: v.boolean() }),
  ]),
});

export function createEditableProfileSource(client: KernelClient): EditableProfileSource {
  return {
    async read(authorization, accountId, signal) {
      const result = await withProfileDeadline(
        (bounded) =>
          client.accounts({ accountId }).profile.get({
            headers: { authorization, 'cache-control': 'no-store' },
            fetch: { cache: 'no-store', signal: bounded },
          }),
        signal,
      );
      if (result.error || !result.data) {
        const failure = nativeProfileFailure(result.status, result.error?.value, result.headers);
        throw new EditableProfileReadError(result.status, Object.keys(failure).length > 1 ? failure : undefined);
      }
      const { profile } = v.parse(response, result.data);
      if (profile.id !== accountId) throw new Error('Profile unavailable');
      return profile;
    },
  };
}
