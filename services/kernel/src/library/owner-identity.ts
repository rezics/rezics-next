import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { shareAccount } from '../access/account-share.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { identityEpochStore, IdentityEpochStoreError } from '../semantic/identity-adapters/index.ts';
import { lookupIdentityReceivingEffect, type IdentityReceivingEffect } from '../semantic/identity-receiving-effects.ts';

/** Structural scopes, never per-session/per-copy membership witnesses. */
export const libraryIdentityRoles = ['member', 'entry', 'label', 'session', 'copy', 'output'] as const;
export type LibraryIdentityRole = (typeof libraryIdentityRoles)[number];

/** This namespace denotes ONLY source-basis invalidation, not whole-role completion. */
export function libraryIdentityInvalidationScope(role: LibraryIdentityRole): string {
  return `library.identity.source.${role}.invalidate`;
}

export function libraryIdentityInvalidationRole(scope: string): LibraryIdentityRole {
  const role = libraryIdentityRoles.find((candidate) => libraryIdentityInvalidationScope(candidate) === scope);
  if (!role)
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Unbound Library identity Source effect scope');
  return role;
}

/** Resolves exact receiving admission in the same native command.
 * The Source-owned validator establishes existence/scope; this directory stores no fact/value/pin.
 * OLD and NEW obligations remain independently retained in the receiving ledger.
 */
export async function registerLibraryOwnerIdentityScope(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
): Promise<LibraryIdentityRole> {
  const record = await lookupIdentityReceivingEffect(tx, effect);
  if (!record || record.applied)
    throw new IdentityEpochStoreError('identity_effect_stale', 'Missing unapplied Library scope receiving record');
  const role = libraryIdentityInvalidationRole(record.source.scope);
  const command = currentCommand(tx);
  const route = routeOf(record.source.id);
  const ownerRoute = routeOf(record.owner);
  if (
    route === null ||
    ownerRoute === null ||
    command.basis !== null ||
    command.partition !== partitionOf(route) ||
    command.partition !== partitionOf(ownerRoute) ||
    record.source.home !== command.partition ||
    record.source.receivingHome !== command.partition
  )
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Library source directory needs same-home custody');
  await shareAccount(tx, record.owner);
  await identityEpochStore.admitHomeEffect(tx, effect);
  await tx.query(
    `INSERT INTO library.owner_identity_scope
      (partition_no,original,source_id,incarnation,role,owner_id,source_route)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(partition_no,original,source_id,incarnation,role) DO NOTHING`,
    [command.partition, record.original, record.source.id, record.source.incarnation, role, record.owner, route],
  );
  // A retained incarnation cannot silently change its owner. A real handoff is a separate obligation.
  const current = await tx.query(
    `SELECT 1 FROM library.owner_identity_scope
     WHERE partition_no=$1 AND original=$2 AND source_id=$3 AND incarnation=$4 AND role=$5
       AND owner_id=$6 AND source_route=$7`,
    [command.partition, record.original, record.source.id, record.source.incarnation, role, record.owner, route],
  );
  if (current.rowCount !== 1)
    throw new IdentityEpochStoreError('identity_effect_stale', 'Library structural scope owner changed');
  return role;
}
