WITH args AS MATERIALIZED (
 SELECT $1::integer AS home,$2::uuid AS job,$3::bigint AS job_epoch,$4::text AS scope_digest,
  $5::integer AS route,$6::uuid AS original,$7::uuid AS terminal,$8::uuid AS generation,
  $9::bigint AS basis_version,$10::integer AS owner_epoch
), qualified AS MATERIALIZED (
 SELECT i.home AS partition_no,i.job AS job_id,i.original,i.job_epoch,i.scope_digest,i.route,
  g.terminal,g.generation,g.closure_incarnation AS incarnation,g.version AS basis_version,g.owner_epoch,
  i.home AS control_partition,o.closure_enrollment AS enrollment,o.closure_source_revision AS source_revision,
  o.closure_source_epoch AS source_epoch,o.closure_export_transaction AS export_transaction,
  prepared.transaction_id AS prepared_transaction_id,prepared.native_epoch AS prepared_epoch,
  prepared.native_position AS prepared_position,acquired.transaction_id AS acquired_transaction_id,
  acquired.native_epoch AS acquired_epoch,acquired.native_position AS acquired_position,
  registration_commit.transaction_id AS registration_transaction_id,registration_commit.epoch AS registration_epoch,
  registration_commit.position AS registration_position,o.closure_registration_xid AS registration_xid,
  o.closure_install_transaction AS install_transaction_id
 FROM args i
 JOIN core.partition p ON p.partition_no=i.home AND p.epoch=i.owner_epoch AND p.write_state='active'
 JOIN semantic.identity_epoch_group g ON g.partition_no=p.partition_no AND g.terminal=i.terminal
  AND g.generation=i.generation AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch
  AND g.closure_state='open' AND g.pending_job=i.job AND g.pending_epoch=i.job_epoch
 JOIN semantic.identity_epoch_prearm_bridge b ON b.partition_no=g.partition_no AND b.generation=g.generation
  AND b.terminal=g.terminal AND b.owner_epoch=g.owner_epoch AND b.basis_version=g.version
  AND b.job_id=i.job AND b.job_epoch=i.job_epoch AND b.scope_digest=i.scope_digest
 JOIN semantic.identity_epoch_admission_attempt a ON a.partition_no=g.partition_no AND a.job_id=i.job
  AND a.job_epoch=i.job_epoch AND a.scope_digest=i.scope_digest AND a.state='acquired'
 JOIN semantic.identity_epoch_admission_handoff h ON h.partition_no=a.partition_no AND h.job_id=a.job_id
  AND h.job_epoch=a.job_epoch AND h.scope_digest=a.scope_digest
 JOIN LATERAL (
  SELECT admitted.terminal FROM jsonb_to_recordset(h.inputs)
   AS admitted(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
  WHERE admitted.terminal=i.terminal AND admitted.generation=i.generation
   AND admitted.basis_version=i.basis_version AND admitted.owner_epoch=i.owner_epoch
   AND jsonb_array_length(h.inputs) BETWEEN 1 AND 2
  LIMIT 1
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
  AND o.original=i.original AND o.terminal=g.terminal AND o.present AND o.closure_state='installed'
  AND o.closure_incarnation=g.closure_incarnation AND o.source_partition=i.route/16 AND o.closure_reservation IS NULL
  AND o.closure_enrollment IS NOT NULL AND o.closure_source_revision IS NOT NULL
  AND o.closure_source_epoch IS NOT NULL AND o.closure_export_transaction IS NOT NULL
  AND o.closure_registration_transaction IS NOT NULL AND o.closure_registration_xid IS NOT NULL
  AND o.closure_install_transaction IS NOT NULL
 JOIN semantic.identity_epoch_native_commit registration_commit ON registration_commit.partition_no=p.partition_no
  AND registration_commit.transaction_id=o.closure_registration_transaction
  AND registration_commit.xmin::text=o.closure_registration_xid AND registration_commit.purpose='bootstrap'
 WHERE i.home<>i.route/16 AND char_length(i.scope_digest)=64
  AND i.route=(get_byte(uuid_send(i.original),10)*256+get_byte(uuid_send(i.original),11))
  AND prepared.native_epoch=p.epoch AND acquired.native_epoch=p.epoch
  AND prepared.native_position<=p.position AND acquired.native_position<=p.position
  AND registration_commit.epoch=p.epoch AND registration_commit.position<=p.position
)
SELECT c.partition_no,c.job_id::text,c.job_epoch::text,c.scope_digest,c.route,c.original::text,
 c.terminal::text,c.generation::text,c.incarnation::text,c.basis_version::text,c.owner_epoch,c.control_partition,
 c.enrollment::text,c.source_revision::text,c.source_epoch,c.export_transaction::text,
 c.prepared_transaction_id::text,c.prepared_epoch,c.prepared_position::text,
 c.acquired_transaction_id::text,c.acquired_epoch,c.acquired_position::text,
 c.registration_transaction_id::text,c.registration_epoch,c.registration_position::text,c.registration_xid,
 c.install_transaction_id::text,c.transaction_id::text,n.epoch AS native_epoch,n.position::text AS native_position
FROM semantic.identity_epoch_mapping_point_custody c
JOIN qualified q ON c.partition_no=q.partition_no AND c.job_id=q.job_id AND c.original=q.original
 AND c.job_epoch=q.job_epoch AND c.scope_digest=q.scope_digest AND c.route=q.route
 AND c.terminal=q.terminal AND c.generation=q.generation AND c.incarnation=q.incarnation
 AND c.basis_version=q.basis_version AND c.owner_epoch=q.owner_epoch AND c.control_partition=q.control_partition
 AND c.enrollment=q.enrollment AND c.source_revision=q.source_revision AND c.source_epoch=q.source_epoch
 AND c.export_transaction=q.export_transaction
 AND c.prepared_transaction_id=q.prepared_transaction_id AND c.prepared_epoch=q.prepared_epoch
 AND c.prepared_position=q.prepared_position
 AND c.acquired_transaction_id=q.acquired_transaction_id AND c.acquired_epoch=q.acquired_epoch
 AND c.acquired_position=q.acquired_position
 AND c.registration_transaction_id=q.registration_transaction_id AND c.registration_epoch=q.registration_epoch
 AND c.registration_position=q.registration_position AND c.registration_xid=q.registration_xid
 AND c.install_transaction_id=q.install_transaction_id AND c.proof_partition IS NULL
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=c.partition_no AND n.transaction_id=c.transaction_id
 AND n.purpose='mapping' AND n.xmin=c.xmin
JOIN core.partition owner ON owner.partition_no=n.partition_no AND owner.epoch=n.epoch
 AND owner.position>=n.position AND owner.write_state='active'
WHERE (SELECT count(*) FROM qualified)=1;
