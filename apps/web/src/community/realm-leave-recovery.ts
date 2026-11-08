import type { MemberState, MembershipResult } from './space';

export type RealmLeaveRecoveryState =
  | { kind: 'refused'; ownerReason: 'last-owner' | 'unavailable' }
  | { kind: 'uncertain'; ownerReason: 'unavailable' };

/** Require the native RFC 9457 envelope AND its explicit command-effect statement.
 * A status, an erased applied result or a missing response cannot prove refusal.
 */
export function nativeMembershipEffect(status: number | undefined, body: unknown): 'not-applied' | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const problem = body as Record<string, unknown>;
  if (
    status !== undefined &&
    status >= 400 &&
    status === problem.status &&
    typeof problem.code === 'string' &&
    problem.type === `https://rezics.com/problems/${problem.code}` &&
    typeof problem.title === 'string' &&
    typeof problem.request_id === 'string' &&
    typeof problem.retryable === 'boolean' &&
    problem.effect_status === 'not_applied'
  )
    return 'not-applied';
}

/** Accounts' declared closed problem; native leave must bind the same locked guard.
 * Generic denial, role data and detail text never establish this reason. No evidence is copied to the browser.
 */
export function nativeRealmLeaveOwnerReason(status: number | undefined, body: unknown): 'last-owner' | undefined {
  if (nativeMembershipEffect(status, body) !== 'not-applied') return;
  const problem = body as Record<string, unknown>;
  if (
    status === 409 &&
    problem.code === 'realm_last_owner' &&
    problem.title === 'Realm Ownership Transfer Required' &&
    problem.retryable === false
  )
    return 'last-owner';
}

export function classifyRealmLeaveFailure(
  result: Exclude<MembershipResult, { outcome: 'accepted' }>,
): RealmLeaveRecoveryState {
  return result.effect === 'not-applied'
    ? { kind: 'refused', ownerReason: result.ownerReason ?? 'unavailable' }
    : { kind: 'uncertain', ownerReason: 'unavailable' };
}

/** A refused intent needs fresh native evidence; no standing read can prove an uncertain write's receipt.
 * Exact replay, with the original key and credential, remains the recovery path for uncertainty.
 */
export function realmLeaveReadResolves(recovery: RealmLeaveRecoveryState, state: MemberState): boolean {
  return recovery.kind === 'refused' && state !== 'pending';
}
