import type { CommandTransaction } from '../command/command.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';

declare const lockedClaim: unique symbol;
export type LockedRealmClaimApproval = Readonly<{
  readonly [lockedClaim]: true;
  realmId: string;
  requestId: string;
  claimantAccountId: string;
  orphanedAt: string;
  claimEligibleAt: string;
  requestedAt: string;
}>;
export type RealmClaimApprovalResult = Readonly<{
  realmId: string;
  requestId: string;
  claimantAccountId: string;
  state: 'owned';
  orphanedAt: string;
  approvedAt: string;
}>;

// Provisional Content-owned declarations. The native source/state implementation
// must replace these unavailable bodies; they never supply source or authority.
export async function lockRealmClaimApprovalSource(
  _tx: CommandTransaction,
  _input: Readonly<{ realmId: string; requestId: string }>,
): Promise<LockedRealmClaimApproval | null> {
  throw new AccessUnavailableError('overloaded');
}

export async function applyRealmClaimApproval(
  _tx: CommandTransaction,
  _source: LockedRealmClaimApproval,
): Promise<RealmClaimApprovalResult> {
  throw new AccessUnavailableError('overloaded');
}
