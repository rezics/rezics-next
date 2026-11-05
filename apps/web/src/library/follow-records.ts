import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import {
  readFollowRecord,
  sendFollowRecord,
  validFollowInput,
  type FollowState,
  type FollowWriteInput,
  type FollowWriteResult,
} from './follow-transport';

export { readFollowRecord, validFollowInput } from './follow-transport';
export type { FollowState, FollowTargetType, FollowWriteInput, FollowWriteResult } from './follow-transport';

/** Provenance comes from actual server preparation, never an expected browser subject. */
export type CurrentFollowState = { subject: string | null; targetId: string; edge: FollowState };

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
    return await sendFollowRecord(client, authorization, input);
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  }
}
