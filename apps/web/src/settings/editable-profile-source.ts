import { withProfileDeadline } from './profile-request-deadline';
import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { MediaProblem } from '../media/kernel';
import type { NativePreferenceFailure } from './preferences';

type ProfileGet = ReturnType<KernelClient['accounts']>['profile']['get'];
export type EditableProfile = NonNullable<Awaited<ReturnType<ProfileGet>>['data']>['profile'];

/** The private source uses the same server-held credential and account key as the existing PATCH. */
export type EditableProfileSource = {
  read: (authorization: string, accountId: string, signal?: AbortSignal) => Promise<EditableProfileRead>;
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
  displayName: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
  bio: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
  links: v.pipe(
    v.array(
      v.strictObject({
        label: v.pipe(
          v.string(),
          v.check((value) => Array.from(value).length <= 64),
        ),
        url: v.pipe(
          v.string(),
          v.check((value) => Array.from(value).length <= 2048),
        ),
      }),
    ),
    v.maxLength(5),
  ),
  avatar: v.nullable(
    v.strictObject({
      media: v.string(),
      width: dimension,
      height: dimension,
      placeholder: v.strictObject({
        thumbhash: v.pipe(v.string(), v.maxLength(64)),
        color: v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/)),
      }),
      variants: v.pipe(
        v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: dimension })),
        v.maxLength(12),
      ),
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
const flags = v.pipe(
  v.array(v.picklist(['posts', 'reviews', 'collections', 'realms'])),
  v.maxLength(4),
  v.check((values) => new Set(values).size === values.length),
);
const textAdvice = v.strictObject({ applicable: v.boolean(), maxLength: v.literal(4096) });
const avatarAdvice = v.strictObject({ applicable: v.boolean() });
const linksAdvice = v.strictObject({
  applicable: v.boolean(),
  maxItems: v.literal(5),
  labelMaxLength: v.literal(64),
  urlMaxLength: v.literal(2048),
});
const viewAdvice = v.strictObject({ applicable: v.boolean(), flags });
const editing = v.union([
  v.strictObject({
    viewer: v.strictObject({ accountId: v.string() }),
    target: v.strictObject({ accountId: v.string(), kind: v.literal('actor') }),
    fields: v.strictObject({
      displayName: textAdvice,
      biography: textAdvice,
      avatar: avatarAdvice,
      links: linksAdvice,
      publicViews: viewAdvice,
    }),
  }),
  v.strictObject({
    viewer: v.strictObject({ accountId: v.string() }),
    target: v.strictObject({ accountId: v.string(), kind: v.literal('organization') }),
    fields: v.strictObject({
      displayName: textAdvice,
      biography: textAdvice,
      avatar: avatarAdvice,
      links: linksAdvice,
      publicViews: viewAdvice,
      speakersListed: avatarAdvice,
    }),
  }),
]);
// The envelope is additive; profile and editing remain closed, producer-shaped observations.
const response = v.object({
  profile: v.variant('kind', [
    v.strictObject({ ...fields, kind: v.literal('actor') }),
    v.strictObject({ ...fields, kind: v.literal('organization'), speakersListed: v.boolean() }),
  ]),
  editing,
});

const patchAck = v.strictObject({ accountId: v.string() });
/** Runtime GET body includes `editing`; the installed client type currently only names `profile`. */
export type ProfileEditing = v.InferOutput<typeof response>['editing'];
export type EditableProfileRead = { profile: EditableProfile; editing: ProfileEditing };
export type EditableProfileEditing = ProfileEditing;
export type EditableProfileRecord = EditableProfileRead;

/** Closed field advice for the official `{ profile, editing }` observation. */
export function closedProfileEditing(
  target: { id: string; kind: 'actor' | 'organization' },
  viewerAccountId = target.id,
): ProfileEditing {
  const identity = {
    displayName: { applicable: true, maxLength: 4096 as const },
    biography: { applicable: true, maxLength: 4096 as const },
    avatar: { applicable: true },
    links: {
      applicable: true,
      maxItems: 5 as const,
      labelMaxLength: 64 as const,
      urlMaxLength: 2048 as const,
    },
    publicViews: {
      applicable: true,
      flags: ['posts', 'reviews', 'collections', 'realms'] as Array<'posts' | 'reviews' | 'collections' | 'realms'>,
    },
  };
  return target.kind === 'organization'
    ? {
        viewer: { accountId: viewerAccountId },
        target: { accountId: target.id, kind: 'organization' },
        fields: { ...identity, speakersListed: { applicable: true } },
      }
    : {
        viewer: { accountId: viewerAccountId },
        target: { accountId: target.id, kind: 'actor' },
        fields: identity,
      };
}

export function officialProfileRead(
  profile: EditableProfile,
  viewerAccountId = profile.id,
): { profile: EditableProfile; editing: ProfileEditing } {
  return { profile, editing: closedProfileEditing(profile, viewerAccountId) };
}

export function parseEditableProfileRead(
  body: unknown,
  accountId: string,
  viewerAccountId = accountId,
): EditableProfileRead {
  const { profile, editing } = v.parse(response, body);
  if (
    profile.id !== accountId ||
    editing.viewer.accountId !== viewerAccountId ||
    editing.target.accountId !== accountId ||
    editing.target.kind !== profile.kind
  )
    throw new Error('Profile unavailable');
  return { profile, editing };
}

export function parseProfilePatchAck(body: unknown, accountId: string): { accountId: string } | undefined {
  const parsed = v.safeParse(patchAck, body);
  return parsed.success && parsed.output.accountId === accountId ? parsed.output : undefined;
}

export function createEditableProfileSource(client: KernelClient, viewerAccountId?: string): EditableProfileSource {
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
      return parseEditableProfileRead(result.data, accountId, viewerAccountId);
    },
  };
}
