import { withProfileDeadline } from '../../settings/profile-request-deadline';
import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { EditableProfileReadError } from '../../settings/editable-profile-source';
import { loadProfileRecord, type ProfilePatch, type ProfileValues } from '../../settings/profile-data';
import { profileFieldErrors } from '../../settings/profile-write';

const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
export const selection = v.strictObject({ accountId: id, viewerId: id });
const text = v.nullable(v.pipe(v.string(), v.maxLength(4096)));
const patch = v.strictObject({
  displayName: v.exactOptional(text),
  biography: v.exactOptional(text),
  avatar: v.exactOptional(v.nullable(id)),
  links: v.exactOptional(v.pipe(v.array(v.strictObject({ label: v.string(), url: v.string() })), v.maxLength(5))),
  publicViews: v.exactOptional(
    v.strictObject({
      posts: v.exactOptional(v.boolean()),
      reviews: v.exactOptional(v.boolean()),
      collections: v.exactOptional(v.boolean()),
      realms: v.exactOptional(v.boolean()),
    }),
  ),
  speakersListed: v.exactOptional(v.boolean()),
});
const submission = v.strictObject({
  ...selection.entries,
  patch,
  idempotencyKey: v.pipe(v.string(), v.uuid()),
  confirmed: v.literal(true),
});
export type Selection = v.InferOutput<typeof selection>;
export type Submission = v.InferOutput<typeof submission>;
export type Failure = 'signed-out' | 'denied' | 'missing' | 'unavailable';
export type ProfilePage = { state: 'ready'; viewerId: string; profile: ProfileValues } | { state: Failure };

export function parseSubmission(input: unknown): Submission {
  const parsed = v.parse(submission, input);
  if (!Object.keys(parsed.patch).length) throw new Error('Empty profile change');
  // Share the established field rules without accepting client snapshots as authority.
  if (
    parsed.patch.links &&
    Object.keys(
      profileFieldErrors({
        accountId: parsed.accountId,
        kind: 'actor',
        displayName: null,
        biography: null,
        avatar: null,
        links: parsed.patch.links,
        publicViews: { posts: false, reviews: false, collections: false, realms: false },
      }),
    ).length
  )
    throw new Error('Invalid profile links');
  return parsed;
}
export function profileFailure(status: number): Failure {
  if (status === 401) return 'signed-out';
  if (status === 403) return 'denied';
  if (status === 404) return 'missing';
  return 'unavailable';
}
export async function readTarget(client: KernelClient, authorization: string, target: Selection, signal?: AbortSignal): Promise<ProfilePage> {
  try {
    const profile = await loadProfileRecord(client, authorization, target.accountId, undefined, signal);
    return { state: 'ready', viewerId: target.viewerId, profile };
  } catch (error) {
    return { state: error instanceof EditableProfileReadError ? profileFailure(error.status) : 'unavailable' };
  }
}

/** Native current authorization is read again before every write, including an exact retry. */
export async function writeTarget(client: KernelClient, authorization: string, input: Submission, signal?: AbortSignal) {
  const current = await readTarget(client, authorization, input, signal);
  if (current.state !== 'ready')
    return {
      ok: false as const,
      status:
        current.state === 'denied'
          ? 403
          : current.state === 'missing'
            ? 404
            : current.state === 'signed-out'
              ? 401
              : 503,
      message: '',
    };
  if (current.profile.kind !== 'organization' && input.patch.speakersListed !== undefined)
    return { ok: false as const, status: 400, message: '' };
  // PATCH evaluates current actor/principal/assignment/floor, grants, operator and consent natively at command T.
  const headers = { authorization, 'idempotency-key': input.idempotencyKey, 'cache-control': 'no-store' };
  const result = await withProfileDeadline((bounded) => client.accounts({ accountId: input.accountId }).patch(input.patch as ProfilePatch, {
    headers,
    fetch: { cache: 'no-store', signal: bounded },
  }), signal);
  if (result.error || !result.data)
    return {
      ok: false as const,
      status: [400, 401, 403, 404, 409, 412, 422, 429].includes(result.status) ? result.status : 503,
      message: '',
    };
  if (result.data.accountId !== input.accountId) throw new Error('Profile acknowledgement mismatch');
  // This is only an acknowledgement; ProfileEditor must perform a fresh private CURRENT GET.
  return { ok: true as const, profile: current.profile };
}
