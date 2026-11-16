/** Exact committed preparation and accepted hold, with the retained writer's actual body size. */
export const readSearchIdentityDispatchBasisSql = `SELECT h.hold_id::text,n.source,n.effect_key,n.action_digest,
  octet_length(w.repair_action) AS action_bytes, o.state,h.accepted_epoch,h.accepted_position::text,h.accepted_transaction_id::text,
  (v.transaction_id IS NOT NULL) AS visible, (r.transaction_id IS NOT NULL) AS released
 FROM search.identity_receiving_native_plan n
 JOIN semantic.identity_epoch_native_commit p ON (p.partition_no,p.transaction_id)=(n.partition_no,n.transaction_id)
  AND p.purpose='search-canonical-index' AND p.xmin=n.xmin
  AND p.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 JOIN core.partition c ON c.partition_no=n.partition_no AND c.epoch=p.epoch
  AND c.write_state='active' AND c.position>=p.position
 JOIN search.identity_receiving_native_hold h ON (h.partition_no,h.plan_id)=(n.partition_no,n.plan_id)
 JOIN search.identity_writer w ON (w.partition_no,w.physical_target,w.original_id)=(n.partition_no,n.physical_target,n.document_id)
  AND w.owner_epoch=c.epoch AND w.repair_locator=n.plan_id::text
 LEFT JOIN search.identity_receiving_native_operation o ON (o.partition_no,o.plan_id)=(n.partition_no,n.plan_id)
 LEFT JOIN semantic.identity_epoch_native_commit v ON (v.partition_no,v.transaction_id,v.position)=
  (o.partition_no,o.visible_transaction_id,o.visible_position)
  AND v.purpose='search-canonical-index' AND v.epoch=c.epoch AND c.position>=v.position
  AND (o.state='applied' OR v.xmin=o.xmin)
  AND v.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 LEFT JOIN semantic.identity_epoch_receiving_search_progress s
  ON (s.partition_no,s.job_id,s.effect_key,s.accepted_transaction_id)=(n.partition_no,n.job_id,n.effect_key,h.accepted_transaction_id)
  AND s.state='released' AND s.released_transaction_id=h.released_transaction_id
  AND s.applied_transaction_id=o.applied_transaction_id
 LEFT JOIN semantic.identity_epoch_native_commit r
  ON (r.partition_no,r.transaction_id)=(s.partition_no,s.released_transaction_id)
  AND r.purpose='identity-receiving-custody' AND r.xmin=s.xmin AND r.xmin=h.xmin
  AND r.epoch=c.epoch AND c.position>=r.position
  AND r.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 WHERE (n.partition_no,n.plan_id,n.job_id,n.job_epoch,n.physical_target,n.original_id,n.scope_digest)=
  ($1,$2,$3,$4,$5,$6,$7) AND h.accepted_epoch=c.epoch AND h.accepted_position<=c.position`;

export const dispatchSearchIdentityOriginalSql = `UPDATE search.identity_writer
 SET writer_token=$5,writer_transaction_id=$6,writer_position=$7,dispatch_state='dispatched'
 WHERE (partition_no,physical_target,original_id,repair_locator)=($1,$2,$3,$4)
 AND writer_token IS NULL AND dispatch_state IN ('settled','cancelled')
 RETURNING original_id`;

export const retainSearchIdentityWriterReceiptSql = `UPDATE search.identity_writer SET repair_receipt=$5
 WHERE (partition_no,physical_target,original_id,repair_locator)=($1,$2,$3,$4)
 AND writer_token IS NULL AND dispatch_state='settled'
 RETURNING original_id`;

export const readBoundedSearchIdentityActionSql = `SELECT repair_locator,
 CASE WHEN octet_length(repair_action)<=$4::integer THEN repair_action END AS value
 FROM search.identity_writer WHERE (partition_no,physical_target,original_id)=($1,$2,$3)`;

export const readBoundedSearchIdentityReceiptSql = `SELECT repair_locator,
 CASE WHEN octet_length(repair_receipt)<=$4::integer THEN repair_receipt END AS value
 FROM search.identity_writer WHERE (partition_no,physical_target,original_id)=($1,$2,$3)`;

export const SEARCH_IDENTITY_WRITER_BODY_MAX = 1048576;
export function searchIdentityWriterBodyBytes(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= SEARCH_IDENTITY_WRITER_BODY_MAX
    ? value + 1024
    : undefined;
}

export const readSearchIdentityPlanBodySizeSql = `SELECT octet_length(source::text) + octet_length(obligations::text) AS bytes
 FROM search.identity_receiving_native_plan WHERE (partition_no,plan_id)=($1,$2)`;
