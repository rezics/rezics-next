import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../session/reading-policy';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { deleteFollow, followStateOf, followWriteHeaders, getFollowPoint, putFollow } from './follow-transport';

export type { FollowTargetType } from './follow-transport';

export type FollowState =
  | { state: 'ready'; following: boolean }
  | { state: 'pending' | 'unavailable' | 'forbidden' | 'signed-out' | 'closed' };
/** Provenance comes from actual server preparation, never an expected browser subject. */
export type CurrentFollowState = { subject: string | null; targetId: string; edge: FollowState };
export type FollowWriteInput = { targetId: string; following: boolean; idempotencyKey: string };
export type FollowWriteResult =
  | { ok: true; following: boolean }
  | { ok: false; reason: 'unauthorized' | 'forbidden' | 'closed' | 'conflict' | 'invalid' | 'unavailable' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validFollowInput(input: FollowWriteInput): boolean {
  return input.targetId.length > 0 && input.targetId.length <= 128 && uuid.test(input.idempotencyKey);
}

/** BASIC reads only the caller's edge, without hydrating a potentially hidden target. */
export async function readFollowRecord(
  client: KernelClient,
  targetId: string,
  authorization: string,
): Promise<FollowState> {
  try {
    const result = await getFollowPoint(client, targetId, authorization);
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { state: 'closed' };
    if (result.status === 404) return { state: 'ready', following: false };
    if (result.status === 401 || result.status === 403) return { state: 'forbidden' };
    const state = followStateOf(result.data, targetId);
    if (result.error || !state) return { state: 'unavailable' };
    return { state: 'ready', following: state === 'following' };
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** One fresh preparation and one BASIC own-edge read, including provenance for an absent edge. */
export async function loadCurrentFollowState(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  targetId: string,
): Promise<CurrentFollowState> {
  let subject: string | null = null;
  try {
    // A reused Request's old WeakMap entries must not impersonate this preparation.
    const current = new Request(request);
    if (await prepareSession(current, sessionEnv)) return { subject, targetId, edge: { state: 'signed-out' } };
    const authorization = viewerCredential(current);
    subject = sessionSubject(current) ?? null;
    if (!subject || !authorization) return { subject: null, targetId, edge: { state: 'signed-out' } };
    return { subject, targetId, edge: await readFollowRecord(client, targetId, authorization) };
  } catch {
    return { subject, targetId, edge: { state: 'unavailable' } };
  }
}

export async function loadFollowState(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  targetId: string,
): Promise<FollowState> {
  try {
    if (await prepareSession(request, sessionEnv)) return { state: 'signed-out' };
    const authorization = viewerCredential(request);
    return authorization ? readFollowRecord(client, targetId, authorization) : { state: 'signed-out' };
  } catch {
    return { state: 'unavailable' };
  }
}

/** DELETE retains the supplied own-edge identity and never probes target readability first. */
export async function writeFollowRecord(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: FollowWriteInput,
): Promise<FollowWriteResult> {
  if (!validFollowInput(input)) return { ok: false, reason: 'invalid' };
  try {
    const stale = await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'unauthorized' };
    const headers = followWriteHeaders(authorization, input.idempotencyKey);
    const result = input.following
      ? await putFollow(client, input.targetId, headers)
      : await deleteFollow(client, input.targetId, headers);
    const body = result.error?.value;
    if (isPlatformClosedProblem(result.status, body)) return { ok: false, reason: 'closed' };
    if (result.status === 409 || (body && 'code' in body && body.code === 'idempotency_conflict'))
      return { ok: false, reason: 'conflict' };
    if (result.status === 401) return { ok: false, reason: 'unauthorized' };
    if (result.status === 403) return { ok: false, reason: 'forbidden' };
    if (result.status === 400 || result.status === 404 || result.status === 422)
      return { ok: false, reason: 'invalid' };
    const state = followStateOf(result.data, input.targetId);
    if (result.error || result.status !== 200 || !state) return { ok: false, reason: 'unavailable' };
    return { ok: true, following: state === 'following' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  }
}
