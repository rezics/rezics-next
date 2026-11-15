WITH args AS MATERIALIZED (
 SELECT $1::integer AS home,$2::uuid AS job,$3::bigint AS job_epoch,$4::text AS scope_digest,
  $5::integer AS route,$6::uuid AS original,$7::uuid AS terminal,$8::uuid AS generation,
  $9::uuid AS incarnation,$10::bigint AS basis_version,$11::integer AS owner_epoch,
  $12::integer AS control_partition,$13::uuid AS enrollment,$14::bigint AS source_revision,
  $15::integer AS source_epoch,$16::uuid AS export_transaction,$17::uuid AS prepared_transaction_id,
  $18::integer AS prepared_epoch,$19::bigint AS prepared_position,$20::uuid AS acquired_transaction_id,
  $21::integer AS acquired_epoch,$22::bigint AS acquired_position,$23::uuid AS registration_transaction_id,
  $24::integer AS registration_epoch,$25::bigint AS registration_position,$26::text AS registration_xid,
  $27::uuid AS install_transaction_id,$28::integer AS proof_partition,$29::uuid AS proof_transaction_id,
  $30::integer AS proof_epoch,$31::bigint AS proof_position,$32::uuid AS transaction_id
), owner AS MATERIALIZED (
 SELECT p.* FROM core.partition p
 WHERE p.partition_no=(SELECT home FROM args) AND p.write_state='active' FOR UPDATE
), live AS MATERIALIZED (
 SELECT i.*,m.closure_state
 FROM args i
 JOIN owner p ON p.partition_no=i.home AND p.epoch=i.source_epoch AND p.write_state='active'
 JOIN semantic.identity_epoch_mapping m ON m.route=i.route AND m.original=i.original AND m.route/16=i.home
 JOIN semantic.subject s ON s.route=m.route AND s.subject_id=m.original
 JOIN semantic.identity_epoch_dirty d ON d.route=m.route AND d.original=m.original
 LEFT JOIN LATERAL (
  SELECT redirect.target FROM semantic.redirect redirect
  WHERE redirect.route=m.route AND redirect.subject_id=m.original ORDER BY redirect.sequence DESC LIMIT 1
 ) r ON true
 JOIN semantic.identity_epoch_native_commit install_commit ON install_commit.partition_no=p.partition_no
  AND install_commit.transaction_id=m.closure_install_transaction
  AND install_commit.xmin::text=m.closure_install_xid AND install_commit.purpose='bootstrap'
 JOIN semantic.identity_epoch_native_commit ack_commit ON ack_commit.partition_no=p.partition_no
  AND ack_commit.transaction_id=m.closure_ack_transaction
  AND ack_commit.xmin::text=m.closure_ack_xid AND ack_commit.purpose='bootstrap'
 WHERE i.home=i.route/16 AND i.home<>i.control_partition AND i.proof_partition=i.control_partition
  AND i.route=(get_byte(uuid_send(i.original),10)*256+get_byte(uuid_send(i.original),11))
  AND char_length(i.scope_digest)=64 AND char_length(i.registration_xid)>0
  AND m.control_partition=i.control_partition AND m.control_group=i.terminal
  AND m.closure_generation=i.generation AND m.closure_incarnation=i.incarnation AND m.closure_enrollment=i.enrollment
  AND m.owner_epoch=i.source_epoch AND m.owner_epoch=p.epoch AND m.source_revision=i.source_revision
  AND m.closure_export_transaction=i.export_transaction
  AND m.closure_registration_transaction=i.registration_transaction_id
  AND m.closure_install_transaction=i.install_transaction_id
  AND ((m.closure_state='active' AND m.source_revision=d.revision AND d.revision=d.captured_revision
    AND coalesce(r.target,m.original)=m.closure_immediate)
   OR (m.closure_state='withdrawn' AND EXISTS (
    SELECT 1 FROM semantic.identity_epoch_mapping_effect prior
    JOIN semantic.identity_epoch_native_commit prior_commit
     ON prior_commit.partition_no=prior.partition_no AND prior_commit.transaction_id=prior.transaction_id
     AND prior_commit.purpose='mapping' AND prior_commit.xmin=prior.xmin
     AND prior_commit.epoch=p.epoch AND prior_commit.position<=p.position
    WHERE prior.partition_no=p.partition_no AND prior.job_id=i.job AND prior.job_epoch=i.job_epoch
     AND prior.scope_digest=i.scope_digest
     AND prior.source_image_version=1 AND octet_length(prior.source_image_digest)=32
     AND prior.source_action='source' AND prior.source_original=m.original
   )))
  AND m.closure_successor_ticket IS NULL AND m.closure_successor_original IS NULL
  AND m.closure_ticket_reservation IS NULL AND m.closure_source_reservation IS NULL
  AND m.closure_cancelled_successor IS NOT TRUE AND m.closure_claim IS NULL AND m.closure_mutation_xid IS NULL
  AND install_commit.epoch=p.epoch AND install_commit.position<=p.position
  AND ack_commit.epoch=p.epoch AND ack_commit.position<=p.position
  AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row pending
   WHERE pending.partition_no=p.partition_no AND pending.transaction_id=m.closure_export_transaction
    AND pending.original=m.original)
 FOR UPDATE OF m
), inserted AS (
 INSERT INTO semantic.identity_epoch_mapping_point_custody(
  partition_no,job_id,original,job_epoch,scope_digest,route,terminal,generation,incarnation,basis_version,
  owner_epoch,control_partition,enrollment,source_revision,source_epoch,export_transaction,
  prepared_transaction_id,prepared_epoch,prepared_position,acquired_transaction_id,acquired_epoch,acquired_position,
  registration_transaction_id,registration_epoch,registration_position,registration_xid,install_transaction_id,
  transaction_id,proof_partition,proof_transaction_id,proof_epoch,proof_position)
 SELECT home,job,original,job_epoch,scope_digest,route,terminal,generation,incarnation,basis_version,
  owner_epoch,control_partition,enrollment,source_revision,source_epoch,export_transaction,
  prepared_transaction_id,prepared_epoch,prepared_position,acquired_transaction_id,acquired_epoch,acquired_position,
  registration_transaction_id,registration_epoch,registration_position,registration_xid,install_transaction_id,
  transaction_id,proof_partition,proof_transaction_id,proof_epoch,proof_position
 FROM live WHERE closure_state='active' AND (SELECT count(*) FROM live)=1
 ON CONFLICT(partition_no,job_id,original) DO NOTHING
 RETURNING transaction_id
), matched AS (
 SELECT c.transaction_id
 FROM semantic.identity_epoch_mapping_point_custody c
 JOIN live i ON c.partition_no=i.home AND c.job_id=i.job AND c.original=i.original
  AND c.job_epoch=i.job_epoch AND c.scope_digest=i.scope_digest AND c.route=i.route
  AND c.terminal=i.terminal AND c.generation=i.generation AND c.incarnation=i.incarnation
  AND c.basis_version=i.basis_version AND c.owner_epoch=i.owner_epoch AND c.control_partition=i.control_partition
  AND c.enrollment=i.enrollment AND c.source_revision=i.source_revision AND c.source_epoch=i.source_epoch
  AND c.export_transaction=i.export_transaction
  AND c.prepared_transaction_id=i.prepared_transaction_id AND c.prepared_epoch=i.prepared_epoch
  AND c.prepared_position=i.prepared_position
  AND c.acquired_transaction_id=i.acquired_transaction_id AND c.acquired_epoch=i.acquired_epoch
  AND c.acquired_position=i.acquired_position
  AND c.registration_transaction_id=i.registration_transaction_id AND c.registration_epoch=i.registration_epoch
  AND c.registration_position=i.registration_position AND c.registration_xid=i.registration_xid
  AND c.install_transaction_id=i.install_transaction_id
  AND c.proof_partition=i.proof_partition AND c.proof_transaction_id=i.proof_transaction_id
  AND c.proof_epoch=i.proof_epoch AND c.proof_position=i.proof_position
 JOIN semantic.identity_epoch_native_commit n ON n.partition_no=c.partition_no AND n.transaction_id=c.transaction_id
  AND n.purpose='mapping' AND n.xmin=c.xmin
 JOIN core.partition owner ON owner.partition_no=n.partition_no AND owner.epoch=n.epoch
  AND owner.position>=n.position AND owner.write_state='active' AND owner.epoch=i.source_epoch
 WHERE i.closure_state IN ('active','withdrawn') AND NOT EXISTS(SELECT 1 FROM inserted)
  AND (SELECT count(*) FROM live)=1
)
SELECT transaction_id::text,true AS inserted FROM inserted
UNION ALL
SELECT transaction_id::text,false AS inserted FROM matched;
