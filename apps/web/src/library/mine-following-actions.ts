import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient, requestLocale } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { sessionSubject } from '../session/request';
import { loadMineFollowingPage, type MineFollowingPage, unfollowFollow } from './mine-following';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from './personal-directory-address';

type MineFollowingInput = { cursor?: string; invalidAddress?: true };

function validateInput(input: unknown): MineFollowingInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid follows cursor');
  const address = personalDirectoryAddress('cursor' in input ? input.cursor : undefined, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  return address.valid
    ? address.cursor
      ? { cursor: address.cursor }
      : {}
    : { ...(typeof address.cursor === 'string' ? { cursor: address.cursor } : {}), invalidAddress: true };
}

export type MineFollowingRead = {
  subject: string | null;
  /** The original requested cursor, even when the reader retries a stale cursor at the first page. */
  cursor: string | null;
  locale: string;
  page: MineFollowingPage;
};

async function readFollowingRequest(data: MineFollowingInput): Promise<MineFollowingRead> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const loaded = await loadMineFollowingPage(kernelClient(), request, env as Partial<SessionEnv>, data);
  // Only a successful reader preparation authorizes this Request's recorded subject. A refused
  // preparation can leave older WeakMap entries behind, so never stamp those around a signed-out page.
  const subject = loaded.signedIn ? (sessionSubject(request) ?? null) : null;
  const page = subject ? loaded : { signedIn: false, follows: [], next: null };
  if (!page.addressInvalid)
    await nameSubjectTypes(page.follows.map((follow) => (follow.targetType === 'subject' ? follow.target : null)));
  return { subject, cursor: data.cursor ?? null, locale: requestLocale(request) ?? 'en', page };
}

export const readMineFollowingPage = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<MineFollowingPage> => (await readFollowingRequest(data)).page);

/** Provenance comes from the same actual request and preparation that produced the private page. */
export const readMineFollowingForViewer = createServerFn({ method: 'GET' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<MineFollowingRead> => readFollowingRequest(data));

function validateUnfollow(input: unknown): { targetId: string; idempotencyKey: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('targetId' in input) ||
    typeof input.targetId !== 'string' ||
    input.targetId.length === 0 ||
    input.targetId.length > 128 ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
  )
    throw new Error('Invalid unfollow request');
  return { targetId: input.targetId, idempotencyKey: input.idempotencyKey };
}

export const unfollow = createServerFn({ method: 'POST' })
  .validator(validateUnfollow)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      return (await unfollowFollow(kernelClient(), request, env as Partial<SessionEnv>, data))
        ? { ok: true }
        : { ok: false };
    } catch (error) {
      if (isPlatformClosedError(error)) return { ok: false };
      return { ok: false };
    }
  });
