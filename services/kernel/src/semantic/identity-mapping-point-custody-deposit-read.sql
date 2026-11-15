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
  $30::integer AS proof_epoch,$31::bigint AS proof_position
)
SELECT c.transaction_id::text
FROM args i
JOIN semantic.identity_epoch_mapping_point_custody c ON c.partition_no=i.home AND c.job_id=i.job AND c.original=i.original
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
JOIN semantic.identity_epoch_mapping m ON m.route=i.route AND m.original=i.original AND m.route/16=i.home
 AND m.control_partition=c.control_partition AND m.control_group=c.terminal
 AND m.closure_generation=c.generation AND m.closure_incarnation=c.incarnation AND m.closure_enrollment=c.enrollment
 AND m.owner_epoch=c.source_epoch AND m.source_revision=c.source_revision
 AND m.closure_export_transaction=c.export_transaction
 AND m.closure_registration_transaction=c.registration_transaction_id
 AND m.closure_install_transaction=c.install_transaction_id
 AND m.closure_state IN ('active','withdrawn') AND m.closure_mutation_xid IS NULL
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=c.partition_no AND n.transaction_id=c.transaction_id
 AND n.purpose='mapping' AND n.xmin=c.xmin
JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position
 AND p.write_state='active' AND p.epoch=c.source_epoch
WHERE i.home=i.route/16 AND i.home<>i.control_partition
 AND (m.closure_state='active' OR (m.closure_state='withdrawn' AND EXISTS (
  SELECT 1 FROM semantic.identity_epoch_mapping_effect prior
  JOIN semantic.identity_epoch_mapping_payload payload
   ON payload.partition_no=prior.partition_no AND payload.job_id=prior.job_id AND payload.unit=prior.unit
  JOIN semantic.identity_epoch_native_commit prior_commit
   ON prior_commit.partition_no=prior.partition_no AND prior_commit.transaction_id=prior.transaction_id
   AND prior_commit.purpose='mapping' AND prior_commit.xmin=prior.xmin
   AND prior_commit.epoch=p.epoch AND prior_commit.position<=p.position
  WHERE prior.partition_no=p.partition_no AND prior.job_id=i.job AND prior.job_epoch=i.job_epoch
   AND prior.scope_digest=i.scope_digest
   AND prior.source_image_version=1 AND octet_length(prior.source_image_digest)=32
   AND payload.result->>'action'='source'
   AND (payload.result->'change'->>'original')::uuid=m.original
 )));
