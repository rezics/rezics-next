import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { shareAccount } from './access-port.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { identityEpochStore, IdentityEpochStoreError } from '../semantic/identity-adapters/index.ts';
import { lookupIdentityReceivingEffect, type IdentityReceivingEffect } from '../semantic/identity-receiving-effects.ts';
import { readOwnerOriginalTruth, currentOwnerState, type OwnerOriginalTruth } from './owner-index.ts';

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
  expectedRole?: LibraryIdentityRole,
): Promise<LibraryIdentityRole> {
  const record = await lookupIdentityReceivingEffect(tx, effect);
  if (!record || record.applied)
    throw new IdentityEpochStoreError('identity_effect_stale', 'Missing unapplied Library scope receiving record');
  const role = expectedRole ?? libraryIdentityInvalidationRole(record.source.scope);
  if (expectedRole && record.source.scope !== 'collection-source')
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Native owner scope needs a Collection Source receipt',
    );
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
  await identityEpochStore().admitHomeEffect(tx, effect);
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

export type LibraryIdentityCandidateInput = Readonly<{
  partition: number;
  owner: string;
  canonical: string;
  original: string;
  source: string;
  incarnation: string;
  role: LibraryIdentityRole;
  fact: string;
  disposition: 'OLD' | 'NEW' | 'first-apply' | 'handoff';
  sourceScope: string;
}>;

function nativeRoute(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Library identity candidate requires a native ID');
  return value;
}

/** Candidate rows retain only source/fact locators. OLD withdrawal and NEW insertion are idempotent;
 * a unique support contributes exactly once to the aggregate structural count.
 */
export async function applyLibraryIdentityCandidate(
  tx: CommandTransaction,
  input: LibraryIdentityCandidateInput,
): Promise<Readonly<{ state: 'applied' | 'unready' | 'handoff'; truth: OwnerOriginalTruth | null }>> {
  const ownerRoute = nativeRoute(input.owner);
  const canonicalRoute = nativeRoute(input.canonical);
  const originalRoute = nativeRoute(input.original);
  const sourceRoute = nativeRoute(input.source);
  if (
    partitionOf(ownerRoute) !== input.partition ||
    partitionOf(canonicalRoute) !== input.partition ||
    partitionOf(originalRoute) !== input.partition ||
    partitionOf(sourceRoute) !== input.partition
  )
    return { state: 'handoff', truth: null };

  const supportKey = [
    input.partition,
    input.owner,
    input.canonical,
    input.original,
    input.source,
    input.incarnation,
    input.role,
    input.fact,
  ];
  if (input.disposition === 'OLD') {
    const removed = await tx.query<{ canonical_id: string; owner_id: string; original_id: string }>(
      `DELETE FROM library.owner_identity_candidate_support
       WHERE partition_no=$1 AND owner_id=$2 AND canonical_id=$3 AND original_id=$4 AND source_id=$5
         AND incarnation=$6 AND role=$7 AND fact_id=$8
       RETURNING canonical_id::text,owner_id::text,original_id::text`,
      supportKey,
    );
    if (removed.rowCount) {
      const aggregate = await tx.query<{ support: string }>(
        `UPDATE library.owner_identity_candidate SET support=support-1
         WHERE partition_no=$1 AND owner_id=$2 AND canonical_id=$3 AND original_id=$4 AND support>1
         RETURNING support::text`,
        supportKey.slice(0, 4),
      );
      if (!aggregate.rowCount) {
        const removedAggregate = await tx.query(
          `DELETE FROM library.owner_identity_candidate
           WHERE partition_no=$1 AND owner_id=$2 AND canonical_id=$3 AND original_id=$4 AND support=1`,
          supportKey.slice(0, 4),
        );
        if (removedAggregate.rowCount !== 1) throw new Error('Library identity candidate aggregate lost support');
      }
    }
    return { state: 'applied', truth: null };
  }
  if (input.disposition === 'handoff') return { state: 'handoff', truth: null };

  const truth = await readOwnerOriginalTruth(tx, input.owner, input.original);
  if (truth.presence === null) return { state: 'unready', truth };
  // Curated collection membership is itself the retained structural fact. Private roles must be
  // independently live in the owner's original tables; a removed label parent never contributes.
  const present =
    input.role === 'member' ||
    (input.role === 'output' && input.sourceScope === 'active_explicit_output') ||
    truth.presence ||
    (input.role === 'entry' && truth.clear !== undefined);
  if (!present) return { state: 'applied', truth };
  const inserted = await tx.query(
    `INSERT INTO library.owner_identity_candidate_support
     (partition_no,owner_id,canonical_id,original_id,source_id,incarnation,role,fact_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING fact_id`,
    supportKey,
  );
  if (inserted.rowCount) {
    const aggregate = await tx.query(
      `INSERT INTO library.owner_identity_candidate(partition_no,owner_id,canonical_id,original_id,support)
       VALUES($1,$2,$3,$4,1)
       ON CONFLICT(partition_no,owner_id,canonical_id,original_id)
       DO UPDATE SET support=library.owner_identity_candidate.support+1`,
      supportKey.slice(0, 4),
    );
    if (aggregate.rowCount !== 1) throw new Error('Library identity candidate aggregate was not retained');
  }
  return { state: 'applied', truth };
}

/** Read a bounded structural original page and recompute state/clear order using owner_write_seq.
 * Caller persists the cursor and merges page winners, including winner.clear when state is absent.
 * Duplicate max sequences are a source defect; clear-only originals never enter the live originals result.
 */
export async function readLibraryIdentityCandidatePage(
  tx: CommandTransaction,
  input: Readonly<{ partition: number; owner: string; canonical: string; after: string | null; limit?: number }>,
) {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Owner identity candidate page must be 1..100');
  const ownerRoute = nativeRoute(input.owner);
  if (partitionOf(ownerRoute) !== input.partition || partitionOf(nativeRoute(input.canonical)) !== input.partition)
    throw new TypeError('Owner identity candidate page crossed its native home');
  const rows = await tx.query<{ original: string }>(
    `SELECT original_id::text AS original FROM library.owner_identity_candidate
     WHERE partition_no=$1 AND owner_id=$2 AND canonical_id=$3 AND ($4::uuid IS NULL OR original_id>$4)
     ORDER BY original_id LIMIT $5`,
    [input.partition, input.owner, input.canonical, input.after, limit + 1],
  );
  const selected = rows.rows.slice(0, limit);
  const truth = await Promise.all(selected.map((row) => readOwnerOriginalTruth(tx, input.owner, row.original)));
  const live = truth.filter((row) => row.presence === true);
  const winner = currentOwnerState(truth);
  return {
    originals: live,
    winner,
    after: selected.at(-1)?.original ?? input.after,
    exhausted: rows.rows.length <= limit,
    examined: selected.length,
    unready: truth.some((row) => row.presence === null),
  };
}
