-- Current identity for a requested self pair. The caller has already selected an active
-- source home and a null current redirect in the same snapshot. Keep int8 values as text
-- across the JSON boundary used by the ordinary identity classifier.
WITH key AS (SELECT :route::integer AS route, :original::uuid AS original),
source AS MATERIALIZED (
  SELECT m.original AS subject_id, m.original, m.terminal, m.control_partition, m.control_group,
         m.epoch::text, m.owner_epoch, m.source_revision::text, m.closure_state, m.closure_immediate,
         m.closure_enrollment, m.closure_generation, m.closure_incarnation, m.closure_install_transaction,
         m.closure_registration_transaction, m.closure_export_transaction, NULL::uuid AS current_target,
         m.recorded_transaction_id, m.erasure_key::text,
         coalesce(d.revision,0)::text AS dirty_revision, coalesce(d.captured_revision,0)::text AS captured_revision
  FROM key k JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(k.route,k.original)
  LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(m.route,m.original)
  WHERE m.terminal=k.original AND m.control_group=k.original
), control AS MATERIALIZED (
  SELECT g.partition_no,g.terminal,s.original AS requested_original,false AS redirected,
         g.owner_epoch,g.closure_state,g.published_epoch::text,g.generation,g.closure_incarnation,
         o.closure_state AS directory_state,o.closure_enrollment AS directory_enrollment,
         o.closure_incarnation AS directory_incarnation,o.closure_install_transaction AS directory_install,
         n.transaction_id AS registration_transaction,o.closure_export_transaction AS directory_export,
         o.closure_source_epoch AS directory_owner,o.closure_source_revision::text AS directory_revision,
         g.pending_job,g.pending_epoch::text,p.epoch AS control_epoch
  FROM source s
  JOIN core.partition p ON p.partition_no=s.control_partition AND p.write_state='active' AND p.moved_to IS NULL
  JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal)=(s.control_partition,s.control_group)
  LEFT JOIN LATERAL (SELECT * FROM semantic.identity_epoch_original
    WHERE (partition_no,generation,original)=(g.partition_no,g.generation,s.original) LIMIT 1) o ON true
  LEFT JOIN LATERAL (SELECT transaction_id FROM semantic.identity_epoch_native_commit
    WHERE partition_no=o.partition_no AND transaction_id=o.closure_registration_transaction
      AND xmin::text=o.closure_registration_xid LIMIT 1) n ON true
)
SELECT to_jsonb(s) AS source,to_jsonb(c) AS control FROM source s CROSS JOIN control c;
