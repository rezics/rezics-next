WITH args AS MATERIALIZED (
 SELECT $1::integer AS home,$2::uuid AS job,$3::bigint AS job_epoch,$4::integer AS unit,
  $5::text AS scope_digest,$6::text AS plan_digest,$7::uuid AS frame,
  $8::integer AS route,$9::uuid AS original,$10::uuid AS control_group,
  $11::uuid AS generation,$12::uuid AS incarnation,$13::integer AS owner_epoch,$14::bigint AS basis_version
), effect AS MATERIALIZED (
 SELECT e.* FROM semantic.identity_epoch_mapping_effect e JOIN args i
  ON e.partition_no=i.home AND e.job_id=i.job AND e.job_epoch=i.job_epoch AND e.unit=i.unit
   AND e.scope_digest=i.scope_digest AND e.plan_digest=i.plan_digest AND e.transaction_id=i.frame
 WHERE e.xmin::text=pg_current_xact_id()::xid::text FOR UPDATE OF e
), gates AS MATERIALIZED (
 SELECT gate.* FROM semantic.identity_epoch_home_gate gate JOIN args i
  ON gate.route=i.route AND gate.destination=i.original AND gate.recorded_transaction_id=i.frame
   AND gate.pending_job=i.job AND gate.pending_epoch=i.job_epoch
 WHERE gate.xmin::text=pg_current_xact_id()::xid::text ORDER BY gate.original LIMIT 2
), qualified AS MATERIALIZED (
 SELECT m.route,m.original
 FROM args i JOIN effect e ON true
 JOIN core.partition p ON p.partition_no=i.home AND p.epoch=i.owner_epoch AND p.write_state='active'
 JOIN semantic.identity_epoch_mapping m ON m.route=i.route AND m.original=i.original AND m.route/16=i.home
 JOIN semantic.identity_epoch_mapping_fence f ON f.route=m.route AND f.destination=m.original
  AND f.job_id=e.job_id AND f.job_epoch=e.job_epoch AND f.transaction_id=e.transaction_id
  AND f.xmin::text=pg_current_xact_id()::xid::text
 JOIN semantic.identity_epoch_group g ON g.partition_no=i.home AND g.terminal=i.control_group
  AND g.generation=i.generation AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch
  AND g.closure_incarnation=i.incarnation AND g.closure_state='open'
  AND g.pending_job=e.job_id AND g.pending_epoch=e.job_epoch
 JOIN semantic.identity_epoch_prearm_bridge b ON b.partition_no=g.partition_no AND b.generation=g.generation
  AND b.terminal=g.terminal AND b.owner_epoch=g.owner_epoch AND b.basis_version=g.version
  AND b.job_id=e.job_id AND b.job_epoch=e.job_epoch AND b.scope_digest=e.scope_digest
 JOIN semantic.identity_epoch_admission_attempt a ON a.partition_no=g.partition_no AND a.job_id=e.job_id
  AND a.job_epoch=e.job_epoch AND a.scope_digest=e.scope_digest AND a.state='acquired'
 JOIN semantic.identity_epoch_admission_receipt acquired ON acquired.partition_no=a.partition_no
  AND acquired.job_id=a.job_id AND acquired.job_epoch=a.job_epoch AND acquired.scope_digest=a.scope_digest
  AND acquired.stage='acquired' AND acquired.version=1
 JOIN semantic.identity_epoch_native_commit acquired_commit
  ON (acquired_commit.partition_no,acquired_commit.transaction_id,acquired_commit.epoch,acquired_commit.position)=
   (acquired.partition_no,acquired.transaction_id,acquired.native_epoch,acquired.native_position)
   AND acquired_commit.purpose='admission' AND acquired_commit.xmin=acquired.xmin
 WHERE m.owner_epoch=i.owner_epoch AND m.closure_state='withdrawn'
  AND m.closure_generation=i.generation AND m.closure_incarnation=i.incarnation
  AND m.closure_mutation_xid=pg_current_xact_id()::text AND m.xmin::text=pg_current_xact_id()::xid::text
  AND m.closure_claim IS NULL AND m.closure_source_reservation IS NULL
  AND m.closure_ticket_reservation IS NULL AND m.closure_successor_ticket IS NULL
  AND m.closure_successor_original IS NULL AND m.closure_cancelled_successor IS NOT TRUE
  AND acquired.native_epoch=p.epoch AND acquired.native_position<=p.position
  AND (SELECT count(*) FROM gates)=1
 FOR UPDATE OF m,p,g,b,a
), completed AS (
 UPDATE semantic.identity_epoch_mapping m SET closure_mutation_xid=NULL
 FROM qualified q WHERE m.route=q.route AND m.original=q.original RETURNING m.original
)
SELECT EXISTS(SELECT 1 FROM completed) AS completed;
