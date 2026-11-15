WITH args AS MATERIALIZED (
 SELECT $1::integer AS home,$2::uuid AS job,$3::bigint AS job_epoch,$4::integer AS unit,
  $5::text AS scope_digest,$6::text AS plan_digest,$7::uuid AS frame,
  $8::integer AS route,$9::uuid AS original,$10::jsonb AS inputs
), effect AS MATERIALIZED (
 SELECT e.* FROM semantic.identity_epoch_mapping_effect e
 WHERE e.partition_no=(SELECT home FROM args) AND e.job_id=(SELECT job FROM args) AND e.job_epoch=(SELECT job_epoch FROM args)
  AND e.unit=(SELECT unit FROM args) AND e.scope_digest=(SELECT scope_digest FROM args) AND e.plan_digest=(SELECT plan_digest FROM args)
  AND e.transaction_id=(SELECT frame FROM args) AND e.xmin::text=pg_current_xact_id()::xid::text
 FOR UPDATE
), owner AS MATERIALIZED (
 SELECT p.* FROM core.partition p
 WHERE p.partition_no=(SELECT home FROM args) AND p.write_state='active' FOR UPDATE
), source AS MATERIALIZED (
 SELECT m.* FROM semantic.identity_epoch_mapping m
 WHERE m.route=(SELECT route FROM args) AND m.original=(SELECT original FROM args) AND m.route/16=(SELECT home FROM args) FOR UPDATE
), gates AS MATERIALIZED (
 SELECT g.* FROM semantic.identity_epoch_home_gate g
 WHERE g.route=(SELECT route FROM args) AND g.destination=(SELECT original FROM args) AND g.recorded_transaction_id=(SELECT frame FROM args)
  AND g.pending_job=(SELECT job FROM args) AND g.pending_epoch=(SELECT job_epoch FROM args)
  AND g.xmin::text=pg_current_xact_id()::xid::text
 ORDER BY g.original LIMIT 2
), frame AS MATERIALIZED (
 SELECT e.partition_no FROM effect e JOIN owner p USING(partition_no)
 JOIN semantic.identity_epoch_mapping_fence f
  ON f.route=(SELECT route FROM args) AND f.destination=(SELECT original FROM args) AND f.job_id=e.job_id
   AND f.job_epoch=e.job_epoch AND f.transaction_id=e.transaction_id
   AND f.xmin::text=pg_current_xact_id()::xid::text
 WHERE (SELECT count(*) FROM gates)=1
), input AS MATERIALIZED (
 SELECT * FROM jsonb_to_recordset((SELECT inputs FROM args))
  AS i(terminal uuid,generation uuid,basis_version bigint,control_partition integer,owner_epoch integer)
 WHERE jsonb_array_length((SELECT inputs FROM args)) BETWEEN 1 AND 2
), qualified AS MATERIALIZED (
 SELECT m.route,m.original,m.control_group,m.closure_generation,m.closure_incarnation,m.owner_epoch,g.version::text AS basis_version,
  CASE WHEN m.closure_state='withdrawn' THEN retained.source_image_digest ELSE sha256(convert_to(jsonb_build_array(
   'rezics.semantic.mapping-point-withdraw/v1',e.job_id,e.job_epoch,e.unit,e.scope_digest,e.plan_digest,e.transaction_id,
   p.node,p.epoch,p.write_state,p.moved_to,s.subject_id,s.recorded_transaction_id,s.xmin::text,
   to_jsonb(m),d.revision::text,d.captured_revision::text,r.sequence,r.target,r.recorded_transaction_id
  )::text,'UTF8')) END AS source_image
 FROM source m JOIN frame valid ON true JOIN effect e ON true JOIN owner p ON true
 JOIN semantic.subject s ON s.route=m.route AND s.subject_id=m.original
 JOIN semantic.identity_epoch_dirty d ON d.route=m.route AND d.original=m.original
 LEFT JOIN LATERAL (
  SELECT redirect.sequence,redirect.target,redirect.recorded_transaction_id FROM semantic.redirect redirect
  WHERE redirect.route=m.route AND redirect.subject_id=m.original ORDER BY redirect.sequence DESC LIMIT 1
 ) r ON true
 JOIN input i ON i.control_partition=p.partition_no AND i.terminal=m.control_group
  AND i.generation=m.closure_generation AND i.owner_epoch=p.epoch
 JOIN semantic.identity_epoch_group g ON g.partition_no=p.partition_no AND g.terminal=i.terminal
  AND g.generation=i.generation AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch
  AND g.closure_incarnation=m.closure_incarnation AND g.closure_state='open'
  AND g.pending_job=e.job_id AND g.pending_epoch=e.job_epoch
 JOIN semantic.identity_epoch_prearm_bridge b ON b.partition_no=g.partition_no AND b.generation=g.generation
  AND b.terminal=g.terminal AND b.owner_epoch=g.owner_epoch AND b.basis_version=g.version
  AND b.job_id=e.job_id AND b.job_epoch=e.job_epoch AND b.scope_digest=e.scope_digest
 JOIN semantic.identity_epoch_admission_attempt a ON a.partition_no=g.partition_no AND a.job_id=e.job_id
  AND a.job_epoch=e.job_epoch AND a.scope_digest=e.scope_digest AND a.state='acquired'
 JOIN semantic.identity_epoch_admission_handoff h ON h.partition_no=a.partition_no AND h.job_id=a.job_id
  AND h.job_epoch=a.job_epoch AND h.scope_digest=a.scope_digest
 JOIN LATERAL (
  SELECT admitted.* FROM jsonb_to_recordset(h.inputs)
   AS admitted(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
  WHERE admitted.terminal=i.terminal AND admitted.generation=i.generation
   AND admitted.basis_version=i.basis_version AND admitted.owner_epoch=i.owner_epoch
   AND jsonb_array_length(h.inputs) BETWEEN 1 AND 2 LIMIT 1
 ) admitted ON true
 JOIN semantic.identity_epoch_admission_receipt prepared ON prepared.partition_no=a.partition_no
  AND prepared.job_id=a.job_id AND prepared.job_epoch=a.job_epoch AND prepared.scope_digest=a.scope_digest
  AND prepared.stage='prepared' AND prepared.version=1
 JOIN semantic.identity_epoch_native_commit prepared_commit
  ON (prepared_commit.partition_no,prepared_commit.transaction_id,prepared_commit.epoch,prepared_commit.position)=
   (prepared.partition_no,prepared.transaction_id,prepared.native_epoch,prepared.native_position)
   AND prepared_commit.purpose='admission' AND prepared_commit.xmin=prepared.xmin
 JOIN semantic.identity_epoch_admission_receipt acquired ON acquired.partition_no=a.partition_no
  AND acquired.job_id=a.job_id AND acquired.job_epoch=a.job_epoch AND acquired.scope_digest=a.scope_digest
  AND acquired.stage='acquired' AND acquired.version=1
 JOIN semantic.identity_epoch_native_commit acquired_commit
  ON (acquired_commit.partition_no,acquired_commit.transaction_id,acquired_commit.epoch,acquired_commit.position)=
   (acquired.partition_no,acquired.transaction_id,acquired.native_epoch,acquired.native_position)
   AND acquired_commit.purpose='admission' AND acquired_commit.xmin=acquired.xmin
 JOIN semantic.identity_epoch_original o ON o.partition_no=g.partition_no AND o.generation=g.generation
  AND o.original=m.original AND o.terminal=g.terminal AND o.present AND o.closure_state='installed'
  AND o.closure_enrollment=m.closure_enrollment AND o.closure_incarnation=m.closure_incarnation
  AND o.closure_source_revision=m.source_revision AND o.closure_source_epoch=m.owner_epoch
  AND o.closure_export_transaction=m.closure_export_transaction
  AND o.closure_registration_transaction=m.closure_registration_transaction
  AND o.closure_install_transaction=m.closure_install_transaction AND o.closure_reservation IS NULL
 JOIN semantic.identity_epoch_native_commit registration_commit ON registration_commit.partition_no=p.partition_no
  AND registration_commit.transaction_id=o.closure_registration_transaction
  AND registration_commit.xmin::text=o.closure_registration_xid AND registration_commit.purpose='bootstrap'
 JOIN semantic.identity_epoch_native_commit install_commit ON install_commit.partition_no=p.partition_no
  AND install_commit.transaction_id=m.closure_install_transaction
  AND install_commit.xmin::text=m.closure_install_xid AND install_commit.purpose='bootstrap'
 JOIN semantic.identity_epoch_native_commit ack_commit ON ack_commit.partition_no=p.partition_no
  AND ack_commit.transaction_id=m.closure_ack_transaction
  AND ack_commit.xmin::text=m.closure_ack_xid AND ack_commit.purpose='bootstrap'
 LEFT JOIN LATERAL (
  SELECT prior.source_image_digest FROM semantic.identity_epoch_mapping_effect prior
  JOIN semantic.identity_epoch_native_commit prior_commit
   ON prior_commit.partition_no=prior.partition_no AND prior_commit.transaction_id=prior.transaction_id
   AND prior_commit.purpose='mapping' AND prior_commit.xmin=prior.xmin
   AND prior_commit.epoch=p.epoch AND prior_commit.position<=p.position
  WHERE prior.partition_no=p.partition_no AND prior.job_id=e.job_id AND prior.job_epoch=e.job_epoch
   AND prior.scope_digest=e.scope_digest AND prior.transaction_id<>e.transaction_id
   AND prior.source_image_version=1 AND octet_length(prior.source_image_digest)=32
   AND prior.source_action='source' AND prior.source_original=m.original
  ORDER BY prior.unit DESC LIMIT 1
 ) retained ON true
 WHERE m.closure_state IN ('active','withdrawn') AND m.control_partition=p.partition_no AND m.owner_epoch=p.epoch
  AND ((m.closure_state='active' AND m.source_revision=d.revision AND d.revision=d.captured_revision
    AND coalesce(r.target,m.original)=m.closure_immediate)
   OR (m.closure_state='withdrawn' AND retained.source_image_digest IS NOT NULL))
  AND m.closure_successor_ticket IS NULL AND m.closure_successor_original IS NULL
  AND m.closure_ticket_reservation IS NULL AND m.closure_source_reservation IS NULL
  AND m.closure_cancelled_successor IS NOT TRUE AND m.closure_claim IS NULL AND m.closure_mutation_xid IS NULL
  AND prepared.native_epoch=p.epoch AND acquired.native_epoch=p.epoch
  AND prepared.native_position<=p.position AND acquired.native_position<=p.position
  AND registration_commit.epoch=p.epoch AND registration_commit.position<=p.position
  AND install_commit.epoch=p.epoch AND install_commit.position<=p.position
  AND ack_commit.epoch=p.epoch AND ack_commit.position<=p.position
  AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row pending
   WHERE pending.partition_no=p.partition_no AND pending.transaction_id=m.closure_export_transaction
    AND pending.original=m.original)
 FOR UPDATE OF g,b,a
), foreign_qualified AS MATERIALIZED (
 SELECT m.route,m.original,m.control_group,m.closure_generation,m.closure_incarnation,m.owner_epoch,
  c.basis_version::text AS basis_version,
  CASE WHEN m.closure_state='withdrawn' THEN retained.source_image_digest ELSE sha256(convert_to(jsonb_build_array(
   'rezics.semantic.mapping-point-withdraw/v1',e.job_id,e.job_epoch,e.unit,e.scope_digest,e.plan_digest,e.transaction_id,
   p.node,p.epoch,p.write_state,p.moved_to,s.subject_id,s.recorded_transaction_id,s.xmin::text,
   to_jsonb(m),d.revision::text,d.captured_revision::text,r.sequence,r.target,r.recorded_transaction_id
  )::text,'UTF8')) END AS source_image
 FROM source m JOIN frame valid ON true JOIN effect e ON true JOIN owner p ON true
 JOIN semantic.subject s ON s.route=m.route AND s.subject_id=m.original
 JOIN semantic.identity_epoch_dirty d ON d.route=m.route AND d.original=m.original
 LEFT JOIN LATERAL (
  SELECT redirect.sequence,redirect.target,redirect.recorded_transaction_id FROM semantic.redirect redirect
  WHERE redirect.route=m.route AND redirect.subject_id=m.original ORDER BY redirect.sequence DESC LIMIT 1
 ) r ON true
 JOIN input i ON i.control_partition<>p.partition_no AND i.terminal=m.control_group
  AND i.generation=m.closure_generation
  AND (SELECT count(*) FROM input named WHERE named.terminal=m.control_group)=1
 JOIN semantic.identity_epoch_mapping_point_custody c ON c.partition_no=p.partition_no AND c.job_id=e.job_id
  AND c.original=m.original AND c.job_epoch=e.job_epoch AND c.scope_digest=e.scope_digest AND c.route=m.route
  AND c.terminal=i.terminal AND c.generation=i.generation AND c.basis_version=i.basis_version
  AND c.owner_epoch=i.owner_epoch AND c.control_partition=i.control_partition AND c.control_partition<>p.partition_no
  AND c.incarnation=m.closure_incarnation AND c.enrollment=m.closure_enrollment
  AND c.source_revision=m.source_revision AND c.source_epoch=m.owner_epoch
  AND c.export_transaction=m.closure_export_transaction
  AND c.registration_transaction_id=m.closure_registration_transaction
  AND c.install_transaction_id=m.closure_install_transaction
  AND c.proof_partition=c.control_partition
 JOIN semantic.identity_epoch_native_commit deposit_commit
  ON deposit_commit.partition_no=c.partition_no AND deposit_commit.transaction_id=c.transaction_id
  AND deposit_commit.purpose='mapping' AND deposit_commit.xmin=c.xmin
  AND deposit_commit.epoch=p.epoch AND deposit_commit.position<=p.position
 JOIN semantic.identity_epoch_native_commit install_commit ON install_commit.partition_no=p.partition_no
  AND install_commit.transaction_id=m.closure_install_transaction
  AND install_commit.xmin::text=m.closure_install_xid AND install_commit.purpose='bootstrap'
 JOIN semantic.identity_epoch_native_commit ack_commit ON ack_commit.partition_no=p.partition_no
  AND ack_commit.transaction_id=m.closure_ack_transaction
  AND ack_commit.xmin::text=m.closure_ack_xid AND ack_commit.purpose='bootstrap'
 LEFT JOIN LATERAL (
  SELECT prior.source_image_digest FROM semantic.identity_epoch_mapping_effect prior
  JOIN semantic.identity_epoch_native_commit prior_commit
   ON prior_commit.partition_no=prior.partition_no AND prior_commit.transaction_id=prior.transaction_id
   AND prior_commit.purpose='mapping' AND prior_commit.xmin=prior.xmin
   AND prior_commit.epoch=p.epoch AND prior_commit.position<=p.position
  WHERE prior.partition_no=p.partition_no AND prior.job_id=e.job_id AND prior.job_epoch=e.job_epoch
   AND prior.scope_digest=e.scope_digest AND prior.transaction_id<>e.transaction_id
   AND prior.source_image_version=1 AND octet_length(prior.source_image_digest)=32
   AND prior.source_action='source' AND prior.source_original=m.original
  ORDER BY prior.unit DESC LIMIT 1
 ) retained ON true
 WHERE m.closure_state IN ('active','withdrawn') AND m.control_partition<>p.partition_no AND m.owner_epoch=p.epoch
  AND m.owner_epoch=c.source_epoch
  AND ((m.closure_state='active' AND m.source_revision=d.revision AND d.revision=d.captured_revision
    AND coalesce(r.target,m.original)=m.closure_immediate)
   OR (m.closure_state='withdrawn' AND retained.source_image_digest IS NOT NULL))
  AND m.closure_successor_ticket IS NULL AND m.closure_successor_original IS NULL
  AND m.closure_ticket_reservation IS NULL AND m.closure_source_reservation IS NULL
  AND m.closure_cancelled_successor IS NOT TRUE AND m.closure_claim IS NULL AND m.closure_mutation_xid IS NULL
  AND install_commit.epoch=p.epoch AND install_commit.position<=p.position
  AND ack_commit.epoch=p.epoch AND ack_commit.position<=p.position
  AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row pending
   WHERE pending.partition_no=p.partition_no AND pending.transaction_id=m.closure_export_transaction
    AND pending.original=m.original)
  AND NOT EXISTS(SELECT 1 FROM qualified)
), held AS MATERIALIZED (
 SELECT * FROM qualified UNION ALL SELECT * FROM foreign_qualified
), withdrawn AS (
 UPDATE semantic.identity_epoch_mapping m SET closure_state='withdrawn',closure_mutation_xid=pg_current_xact_id()::text
 FROM held q WHERE m.route=q.route AND m.original=q.original
 RETURNING q.control_group::text,q.closure_generation::text,q.closure_incarnation::text,q.owner_epoch,q.basis_version,q.source_image
)
SELECT CASE
 WHEN NOT EXISTS(SELECT 1 FROM frame) THEN 'unavailable'
 WHEN (SELECT closure_state FROM source)='legacy' THEN 'legacy'
 WHEN EXISTS(SELECT 1 FROM withdrawn) THEN 'withdrawn'
 ELSE 'unavailable' END AS status,
 (SELECT control_group FROM withdrawn) AS control_group,
 (SELECT closure_generation FROM withdrawn) AS generation,
 (SELECT closure_incarnation FROM withdrawn) AS incarnation,
 (SELECT owner_epoch FROM withdrawn) AS owner_epoch,
 (SELECT basis_version FROM withdrawn) AS basis_version,
 (SELECT source_image FROM withdrawn) AS source_image;
