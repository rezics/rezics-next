import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { partitionOf, routeOf, ROUTES } from '../route/route.ts';
import type {
  BulkReason,
  ImmutableTarget,
  OutcomeView,
  ReceiptLocator,
  TargetEvidence,
  TargetState,
} from './bulk-contract.ts';
import type { CollectionBulkOperation } from './collection-bulk-store.ts';
import outcomePage from './bulk-outcome-page.sql';
import statePage from './bulk-outcome-state-page.sql';

const states: readonly TargetState[] = [
  'pending',
  'reconciling',
  'applied',
  'no_effect',
  'conflict',
  'denied',
  'failed',
  'cancelled',
];
const decimal = /^(0|[1-9][0-9]*)(?![\s\S])/;
type RemovalEvidence = Pick<OutcomeView, 'deletion' | 'memberDeletion'>;
type OutcomeRow = Awaited<ReturnType<typeof outcomePage.run>>[number];
type PageOwner = { route: number; accountId: string; operationId: string };
type EvidenceSource = Pick<CollectionBulkOperation, 'request' | 'sourceDigest'>;

/** Project only stored native terminal evidence, never a live tombstone or a guessed deadline.
 * This is not authorization. The operation reader must still check the owner and each resource.
 */
function removalEvidence(row: OutcomeRow, owner: PageOwner, operation?: EvidenceSource): RemovalEvidence {
  const unavailable: RemovalEvidence = { deletion: null, memberDeletion: null };
  const value = row.evidence as TargetEvidence | null;
  const target = row.target as ImmutableTarget | null;
  const receipt = row.receipt as ReceiptLocator | null;
  if (
    !operation ||
    !value ||
    !target ||
    !receipt ||
    row.state !== 'applied' ||
    row.reason !== null ||
    row.resultingMemberId !== null ||
    value.outcome !== 'applied' ||
    value.reason !== null ||
    value.resultingMemberId !== null ||
    value.operationId !== owner.operationId ||
    value.ordinal !== row.ordinal ||
    value.sourceDigest !== operation.sourceDigest ||
    row.sourceDigest !== operation.sourceDigest ||
    target.operationId !== owner.operationId ||
    target.ordinal !== row.ordinal ||
    target.subjectId !== row.subjectId ||
    !isDeepStrictEqual(value.receipt, receipt) ||
    receipt.principalKind !== 'account' ||
    receipt.principalId !== owner.accountId ||
    receipt.commandKind !== 'library.collectionBulk.target' ||
    receipt.key !== `${owner.operationId}:${row.ordinal}` ||
    !/^[a-f0-9]{64}$/.test(receipt.digest)
  )
    return unavailable;

  const nativeRoute = target.kind === 'occurrence' ? routeOf(target.collectionId) : owner.route;
  if (
    nativeRoute === null ||
    receipt.partition !== partitionOf(nativeRoute) ||
    routeOf(value.transactionId ?? '') === null
  )
    return unavailable;
  const valid = (deletionId: string, revision: number, deadline: string) =>
    routeOf(deletionId) !== null &&
    Number.isSafeInteger(revision) &&
    revision > 0 &&
    typeof deadline === 'string' &&
    Number.isFinite(Date.parse(deadline));

  if (
    operation.request.action === 'remove_from_library' &&
    target.kind === 'subject' &&
    target.expected?.kind === 'present' &&
    row.memberId === null &&
    row.collectionId === null &&
    value.deletion &&
    !value.memberDeletion
  ) {
    const { deletionId, revision, restoreUntil } = value.deletion;
    // Personal deletion identity is the original native transaction UUID, not a routed member ID.
    if (
      deletionId === value.transactionId &&
      revision === target.expected.revision + 1 &&
      valid(deletionId, revision, restoreUntil)
    )
      return {
        deletion: { deletionId, revision, restoreUntil },
        memberDeletion: null,
      };
  }
  if (
    operation.request.action === 'remove_from_collection' &&
    target.kind === 'occurrence' &&
    target.expected &&
    target.collectionId === operation.request.collectionId &&
    row.collectionId === target.collectionId &&
    row.memberId === target.memberId &&
    value.memberDeletion &&
    !value.deletion
  ) {
    const { deletionId, revision, purgeAfter } = value.memberDeletion;
    if (routeOf(deletionId) === nativeRoute && valid(deletionId, revision, purgeAfter))
      return {
        deletion: null,
        memberDeletion: { deletionId, revision, purgeAfter },
      };
  }
  return unavailable;
}

/**
 * Caller must independently authorize and prove the exact operation owner on this same source RR client first.
 * Native producers give every target the root owner. This seek cannot discover ownership of a foreign operation.
 * State is current at the page snapshot; nextAfter is an internal decimal boundary, not a wire cursor.
 */
export async function pageBulkOutcomes(
  client: Pick<PoolClient, 'query'>,
  input: {
    route: number;
    accountId: string;
    operationId: string;
    after: string | null;
    limit: number;
    state: TargetState | null;
    /** Read from the same currently authorized operation snapshot, never supplied by the wire caller. */
    operation?: EvidenceSource;
  },
): Promise<{ outcomes: OutcomeView[]; nextAfter: string | null }> {
  const { route, accountId, operationId, after, limit, state } = input;
  if (
    !Number.isInteger(route) ||
    route < 0 ||
    route >= ROUTES ||
    routeOf(accountId) !== route ||
    routeOf(operationId) !== route
  )
    throw new RangeError('Owner and operation must carry the source route');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new RangeError('Limit must be an integer from 1 to 20');
  if (state !== null && !states.includes(state)) throw new TypeError('Invalid target state');
  if (after !== null && (typeof after !== 'string' || !decimal.test(after)))
    throw new TypeError('After must be a canonical nonnegative decimal');
  const parameters = {
    route,
    account_id: accountId,
    operation_id: operationId,
    after: after ?? '-1',
    page_limit: limit + 1,
  };
  const rows =
    state === null
      ? await outcomePage.run(client, parameters)
      : await statePage.run(client, { ...parameters, state });
  let previous = BigInt(after ?? '-1');
  for (const row of rows) {
    if (typeof row.ordinal !== 'string' || !decimal.test(row.ordinal) || BigInt(row.ordinal) <= previous)
      throw new TypeError('Invalid or unordered outcome ordinal');
    previous = BigInt(row.ordinal);
  }
  const outcomes = rows.slice(0, limit).map((row): OutcomeView => ({
    ordinal: row.ordinal,
    subjectId: row.subjectId,
    memberId: row.memberId,
    state: row.state as TargetState,
    reason: row.reason as BulkReason | null,
    resultingMemberId: row.resultingMemberId,
    ...removalEvidence(row, input, input.operation),
  }));
  return {
    outcomes,
    nextAfter: rows.length > limit ? outcomes.at(-1)!.ordinal : null,
  };
}
