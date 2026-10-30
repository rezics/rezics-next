import type { MemberState, MembershipResult } from './space';

export type RealmLeaveRecoveryState = {
  kind: 'refused' | 'uncertain';
  ownerReason: 'unavailable';
};

/** Consumer seam: Accounts currently publishes no closed last-holder HTTP discriminator.
 * Its generic forbidden response, direct-role data and detail text cannot identify an owner.
 */
function ownerReason(_result: MembershipResult): RealmLeaveRecoveryState['ownerReason'] {
  return 'unavailable';
}

/** Require the native RFC 9457 envelope AND its explicit command-effect statement.
 * A status, an erased applied result or a missing response cannot prove refusal.
 */
export function nativeMembershipEffect(status: number | undefined, body: unknown): 'not-applied' | undefined {
  if (!body || typeof body !== 'object') return;
  const problem = body as Record<string, unknown>;
  if (
    status !== undefined && status >= 400 && status === problem.status &&
    typeof problem.code === 'string' && problem.type === `https://rezics.com/problems/${problem.code}` &&
    typeof problem.title === 'string' && typeof problem.request_id === 'string' &&
    typeof problem.retryable === 'boolean' && problem.effect_status === 'not_applied'
  ) return 'not-applied';
}

export function classifyRealmLeaveFailure(result: Exclude<MembershipResult, { outcome: 'accepted' }>): RealmLeaveRecoveryState {
  return { kind: result.effect === 'not-applied' ? 'refused' : 'uncertain', ownerReason: ownerReason(result) };
}

/** Only a fresh membership + participation read may release a refused intent.
 * A still-member or denied read cannot settle an uncertain leave or release its key.
 */
export function realmLeaveReadResolves(recovery: RealmLeaveRecoveryState, state: MemberState): boolean {
  return recovery.kind === 'uncertain' ? state === 'none' : state !== 'pending';
}
