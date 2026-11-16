/** Resolve only the newest directory checkpoint for this pending job on its current control home. */
export const readSearchIdentityDirectorySql = `SELECT j.scope_digest,j.intent->>'release' AS release,s.transaction_id::text,s.native_epoch,s.native_position::text,s.frontier,
  (s.transaction_id IS NULL OR (c.transaction_id IS NOT NULL AND p.epoch=c.epoch AND p.position>=c.position)) AS proven
 FROM semantic.identity_epoch_job j
 JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'
 LEFT JOIN LATERAL (
   SELECT transaction_id,native_epoch,native_position,scope_digest,frontier,xmin
   FROM semantic.identity_epoch_step
   WHERE (partition_no,job_id,job_epoch)=(j.partition_no,j.job_id,j.epoch)
     AND step='search-canonical-index' AND state='more' AND frontier->'after'->>0='search-directory'
   ORDER BY native_position DESC,transaction_id DESC LIMIT 1
 ) s ON true
 LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
   (j.partition_no,s.transaction_id,s.native_epoch,s.native_position)
   AND c.purpose='search-canonical-index' AND c.xmin=s.xmin
   AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid AND s.scope_digest=j.scope_digest
 WHERE (j.partition_no,j.job_id,j.epoch)=($1,$2,$3) AND j.state='pending'`;

// Older jobs can retain materialized changes alongside their admitted input generations.
export const readSearchIdentityMaterializedOriginalSql = `SELECT original::text,previous_terminal::text,terminal::text
 FROM semantic.identity_epoch_change
 WHERE (partition_no,job_id)=($1,$2)
   AND original>coalesce($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY original LIMIT 1`;

/** The plan's existing native unique key serves at most four exact effect keys for a single original. */
export const readSearchIdentityOriginalPlanSql = `SELECT n.effect_key,n.source,(p.partition_no IS NOT NULL) AS proven
 FROM unnest($4::text[]) k(effect_key)
 JOIN LATERAL (
   SELECT partition_no,transaction_id,effect_key,original_id,physical_target,source,xmin
   FROM search.identity_receiving_native_plan
   WHERE (partition_no,job_id,job_epoch,effect_key)=($1,$2,$3,k.effect_key)
   LIMIT 1
 ) n ON true
 LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(n.partition_no,n.transaction_id)
   AND c.purpose='search-canonical-index' AND c.xmin=n.xmin
   AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 LEFT JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch
   AND p.write_state='active' AND p.position>=c.position
 WHERE n.original_id=$5 AND n.physical_target=$6
 ORDER BY n.effect_key LIMIT 2`;

/** Common plans survive retirement of the pending key. This read also supports exact old-scope replay. */
export const readSearchIdentityCommonPlanSql = `SELECT p.binding,p.binding_digest,p.transaction_id AS plan_transaction_id,j.scope_digest
 FROM semantic.identity_epoch_receiving_plan p
 JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(p.partition_no,p.transaction_id)
   AND c.purpose='identity-receiving-plan' AND c.xmin=p.xmin
   AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 JOIN semantic.identity_epoch_job j ON (j.partition_no,j.job_id,j.epoch)=(p.partition_no,p.job_id,p.job_epoch)
 JOIN core.partition o ON o.partition_no=c.partition_no AND o.epoch=c.epoch
   AND o.write_state='active' AND o.position>=c.position
 WHERE (p.partition_no,p.job_id,p.job_epoch,p.effect_key)=($1,$2,$3,$4) AND j.state='pending'
   AND p.binding->>'step'='search-canonical-index'`;

/** A settled old scope can replay after its queue key was retired. Require its exact custody on either path. */
export const advanceSearchIdentityOriginalSql = `WITH settled AS MATERIALIZED (
 SELECT p.partition_no,p.job_id,p.job_epoch,p.effect_key,p.transaction_id
 FROM semantic.identity_epoch_receiving_plan p
 JOIN semantic.identity_epoch_effect_receipt e USING (partition_no,job_id,effect_key)
 JOIN semantic.identity_epoch_receiving_custody a USING (partition_no,job_id,effect_key)
 JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(a.partition_no,a.transaction_id)
   AND c.purpose='identity-receiving-custody' AND c.xmin=a.xmin
   AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 JOIN semantic.identity_epoch_job j ON (j.partition_no,j.job_id,j.epoch)=(p.partition_no,p.job_id,p.job_epoch)
 JOIN core.partition o ON o.partition_no=p.partition_no AND o.epoch=c.epoch
   AND o.write_state='active' AND o.position>=c.position
 WHERE (p.partition_no,p.job_id,p.job_epoch,p.effect_key,p.transaction_id)=($1,$2,$3,$4,$5)
   AND p.binding_digest=$6 AND p.binding->>'step'='search-canonical-index'
   AND j.state='pending' AND j.scope_digest=$11
   AND e.step='search-canonical-index' AND e.kind=CASE p.binding->'source'->>'disposition'
    WHEN 'OLD' THEN 'remove' WHEN 'handoff' THEN 'pending-fence'
    WHEN 'NEW' THEN 'add' WHEN 'first-apply' THEN 'add' END
   AND (e.native_partition,e.native_epoch,e.native_position,e.native_transaction_id)=($7,$8,$9,$10)
   AND NOT EXISTS (SELECT 1 FROM search.identity_receiving_native_scope_pending q
     WHERE (q.partition_no,q.job_id,q.job_epoch,q.effect_key)=(p.partition_no,p.job_id,p.job_epoch,p.effect_key)
       AND q.plan_transaction_id<>p.transaction_id)
), retired AS (
 DELETE FROM search.identity_receiving_native_scope_pending q USING settled s
 WHERE (q.partition_no,q.job_id,q.job_epoch,q.effect_key,q.plan_transaction_id)=
   (s.partition_no,s.job_id,s.job_epoch,s.effect_key,s.transaction_id)
 RETURNING q.effect_key
)
SELECT effect_key FROM settled`;

/** One original-home admission can be retained for a committed control request. */
export const readSearchIdentityWriterAdmissionSql = `SELECT s.transaction_id::text,
  (s.scope_digest=$5 AND s.frontier->'after'->>2=$6 AND o.partition_no IS NOT NULL) AS proven
 FROM semantic.identity_epoch_step s
 LEFT JOIN semantic.identity_epoch_native_commit c
   ON (c.partition_no,c.transaction_id,c.epoch,c.position)=(s.partition_no,s.transaction_id,s.native_epoch,s.native_position)
   AND c.purpose='search-canonical-index' AND c.xmin=s.xmin
   AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 LEFT JOIN core.partition o ON o.partition_no=c.partition_no AND o.epoch=c.epoch
   AND o.write_state='active' AND o.position>=c.position
 WHERE (s.partition_no,s.job_id,s.job_epoch)=($1,$2,$3)
   AND s.step='search-canonical-index' AND s.state='more'
   AND s.frontier->'after'->>0='search-writer-admitted' AND s.frontier->'after'->>1=$4`;

/** Read the latest committed Source support cursor for one phase of this exact writer request. */
export const readSearchIdentityWriterSupportSql = `WITH latest AS MATERIALIZED (
 SELECT partition_no,transaction_id,native_epoch,native_position,scope_digest,frontier,xmin
 FROM semantic.identity_epoch_step
 WHERE (partition_no,job_id,job_epoch)=($1,$2,$3)
   AND step='search-canonical-index' AND state='more'
   AND frontier->'after'->>0='search-writer-support'
   AND frontier->'after'->>1=$4 AND frontier->'after'->>2=$5
 ORDER BY native_position DESC,transaction_id DESC LIMIT 1
)
SELECT s.transaction_id::text,s.frontier,(s.scope_digest=$6 AND o.partition_no IS NOT NULL) AS proven
FROM latest s
LEFT JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id,c.epoch,c.position)=(s.partition_no,s.transaction_id,s.native_epoch,s.native_position)
 AND c.purpose='search-canonical-index' AND c.xmin=s.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
LEFT JOIN core.partition o ON o.partition_no=c.partition_no AND o.epoch=c.epoch
 AND o.write_state='active' AND o.position>=c.position`;
