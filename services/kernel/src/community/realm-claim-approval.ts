import { REALM_OWNER_ROLE } from '../access/realm-ownership.ts';
import { resourceRoleHeld } from '../access/resource-role-held.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  type CommandTransaction,
  type CurrentCommand,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import lockRealm from './realm-claim-approval-realm-lock.sql';
import lockRequest from './realm-claim-approval-lock.sql';
import ownRealm from './realm-claim-approval-own.sql';
import approveRequest from './realm-claim-approval-apply.sql';

const lockedClaim: unique symbol = Symbol('native locked Realm claim');
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
const sources = new WeakMap<LockedRealmClaimApproval, { tx: CommandTransaction; command: CurrentCommand }>();
const conflict = () =>
  new ProblemError('conflict', { detail: 'The native Realm claim is no longer pending and eligible.' });

/** Source custody only. Accounts owns current platform admission, receipt replay and grants. */
export async function lockRealmClaimApprovalSource(
  tx: CommandTransaction,
  input: Readonly<{ realmId: string; requestId: string }>,
): Promise<LockedRealmClaimApproval | null> {
  const command = currentCommand(tx);
  const route = routeOf(input.realmId);
  if (route === null || routeOf(input.requestId) !== route || command.partition !== partitionOf(route))
    throw conflict();
  const realm = await lockRealm.run(tx, { route, realm: input.realmId, at: authoritativeTimeValue(command.time) });
  if (!realm) return null;
  const request = await lockRequest.run(tx, {
    route,
    realm: input.realmId,
    request: input.requestId,
    at: authoritativeTimeValue(command.time),
  });
  if (!request) return null;
  if (
    !realm.active ||
    !realm.eligible ||
    realm.ownership_state !== 'orphaned' ||
    !realm.orphaned_at ||
    !realm.claim_eligible_at ||
    !request.current_request ||
    request.state !== 'pending' ||
    request.orphaned_at !== realm.orphaned_at
  )
    throw conflict();
  const source = Object.freeze<LockedRealmClaimApproval>({
    [lockedClaim]: true,
    realmId: input.realmId,
    requestId: input.requestId,
    claimantAccountId: request.account_id,
    orphanedAt: realm.orphaned_at,
    claimEligibleAt: realm.claim_eligible_at,
    requestedAt: request.requested_at,
  });
  sources.set(source, { tx, command });
  return source;
}

/** Consume only native locks in this live attempt, after Accounts has installed the owner grant. */
export async function applyRealmClaimApproval(
  tx: CommandTransaction,
  source: LockedRealmClaimApproval,
): Promise<RealmClaimApprovalResult> {
  const binding = sources.get(source);
  const command = currentCommand(tx);
  if (!binding || binding.tx !== tx || binding.command !== command) throw conflict();
  const current = await lockRealmClaimApprovalSource(tx, source);
  if (
    !current ||
    current.claimantAccountId !== source.claimantAccountId ||
    current.orphanedAt !== source.orphanedAt ||
    current.claimEligibleAt !== source.claimEligibleAt ||
    current.requestedAt !== source.requestedAt
  )
    throw conflict();
  const route = routeOf(source.realmId);
  if (route === null) throw conflict();
  if (
    !(await resourceRoleHeld(tx, {
      resource: { route, id: source.realmId },
      role: REALM_OWNER_ROLE,
      accountId: source.claimantAccountId,
      at: command.time,
    }))
  )
    throw conflict();
  const at = authoritativeTimeValue(command.time);
  if (
    !(await ownRealm.run(tx, {
      route,
      realm: source.realmId,
      orphaned: source.orphanedAt,
      eligible: source.claimEligibleAt,
    }))
  )
    throw conflict();
  const approved = await approveRequest.run(tx, {
    route,
    realm: source.realmId,
    request: source.requestId,
    account: source.claimantAccountId,
    orphaned: source.orphanedAt,
    requested: source.requestedAt,
    at,
  });
  if (!approved?.approved_at) throw conflict();
  sources.delete(source);
  return {
    realmId: source.realmId,
    requestId: source.requestId,
    claimantAccountId: source.claimantAccountId,
    state: 'owned',
    orphanedAt: source.orphanedAt,
    approvedAt: approved.approved_at,
  };
}
