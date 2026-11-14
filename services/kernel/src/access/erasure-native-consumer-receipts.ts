import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { continuationEntryDigest, type ContinuationEntry } from './committed-continuations.ts';

const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
const BASIS = { actorAccountId: SERVICE_ID, clientId: 'internal-access', requestedBy: null };

export type ContinuationEffectSource = {
  account_id: string;
  command_key_prefix: string | null;
  prior_operator_account_id: string | null;
  prior_reservation_id: string | null;
  prior_handle: string | null;
};

/** Resolve only a business receipt for an immutable original entry. Its native
 * request digest binds the committed effect to the same subject and target;
 * continuation authorization and later commands cannot substitute for it. */
export async function originalContinuationEffectReceipt(
  tx: PoolClient,
  root: ContinuationEffectSource,
  entry: ContinuationEntry,
): Promise<boolean> {
  if (
    root.command_key_prefix === null ||
    entry.key !== `${root.command_key_prefix}:${entry.step}` ||
    entry.digest !== continuationEntryDigest(entry)
  )
    return false;

  let route: number;
  let kind: string;
  let request: unknown;
  if (entry.step === 'retire-operator' || entry.step === 'release-operator') {
    const operatorAccountId = root.prior_operator_account_id;
    const reservationId = root.prior_reservation_id;
    if (!operatorAccountId || !reservationId) return false;
    const anchor = entry.step === 'retire-operator' ? root.account_id : operatorAccountId;
    const anchorRoute = routeOf(anchor);
    if (anchorRoute === null || entry.target !== `${anchor}:${reservationId}`) return false;
    route = anchorRoute;
    const nativeKind = entry.step === 'retire-operator' ? 'responsibility-retired' : 'responsibility-released';
    kind = `access.operator.${nativeKind}`;
    // operator.ts receipts the full responsibility input (including the key)
    // on the subject for retirement and on the operator for release.
    request = [
      anchor,
      nativeKind,
      BASIS,
      null,
      { operatorAccountId, subjectAccountId: root.account_id, reservationId, key: entry.key },
    ];
  } else if (entry.step === 'redirect-deleted-handle') {
    if (!root.prior_handle || entry.target !== root.prior_handle) return false;
    const handle = root.prior_handle.toLowerCase();
    route = createHash('sha256').update(handle).digest().readUInt16BE(0);
    kind = 'access.handle-redirected';
    // lifecycleExecutor uses the normalized handle's route and the redirect
    // input without its key. Both commands use the internal Access principal.
    request = [route, handle, 'handle-redirected', BASIS, { handle, accountId: root.account_id }];
  } else return false;

  const receipt = await tx.query(
    `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
     AND command_kind=$3 AND idempotency_key=ANY($4::text[]) AND request_digest=$5 LIMIT 1`,
    [
      partitionOf(route),
      SERVICE_ID,
      kind,
      nativeReceiptKeyCandidates(tx, kind, SERVICE_ID, `${route}:${entry.key}`),
      createHash('sha256').update(canonicalize(request)!).digest(),
    ],
  );
  return receipt.rowCount === 1;
}
