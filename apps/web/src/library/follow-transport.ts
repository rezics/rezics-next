import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '@rezics/client';

type NativeFollow = NonNullable<Awaited<ReturnType<KernelClient['follows']['get']>>['data']>['follows'][number];
export type FollowTargetType = NativeFollow['targetType'];
export type FollowState =
  | { state: 'ready'; following: boolean }
  | { state: 'pending' | 'unavailable' | 'forbidden' | 'signed-out' | 'closed' };
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
    const result = await client.follows({ targetId }).get({
      query: { view: 'BASIC' },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { state: 'closed' };
    if (result.status === 404) return { state: 'ready', following: false };
    if (result.status === 401 || result.status === 403) return { state: 'forbidden' };
    if (
      result.error ||
      result.status !== 200 ||
      !result.data?.follow ||
      result.data.follow.targetId !== targetId ||
      !['following', 'unfollowed'].includes(result.data.follow.state)
    )
      return { state: 'unavailable' };
    return { state: 'ready', following: result.data.follow.state === 'following' };
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** Dispatches one original intent. A receipt acknowledges that command, not a fresh edge read.
 * Session preparation belongs to the BFF; this transport also runs against the native handler in acceptance.
 */
export async function sendFollowRecord(
  client: KernelClient,
  authorization: string,
  input: FollowWriteInput,
): Promise<FollowWriteResult> {
  if (!validFollowInput(input)) return { ok: false, reason: 'invalid' };
  try {
    const headers = { authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) };
    const target = client.follows({ targetId: input.targetId });
    const result = input.following
      ? await target.put(undefined, { headers })
      : await target.delete(undefined, { headers });
    const body = result.error?.value;
    if (isPlatformClosedProblem(result.status, body)) return { ok: false, reason: 'closed' };
    if (result.status === 409 || (body && 'code' in body && body.code === 'idempotency_conflict'))
      return { ok: false, reason: 'conflict' };
    if (result.status === 401) return { ok: false, reason: 'unauthorized' };
    if (result.status === 403) return { ok: false, reason: 'forbidden' };
    if (result.status === 400 || result.status === 404 || result.status === 422)
      return { ok: false, reason: 'invalid' };
    if (
      result.error ||
      result.status !== 200 ||
      !result.data?.follow ||
      result.data.follow.targetId !== input.targetId ||
      !['following', 'unfollowed'].includes(result.data.follow.state)
    )
      return { ok: false, reason: 'unavailable' };
    return { ok: true, following: result.data.follow.state === 'following' };
  } catch (error) {
    return { ok: false, reason: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
