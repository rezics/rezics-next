WITH parameters AS (SELECT $1::uuid job)
SELECT s.original FROM semantic.identity_epoch_admission_source s
JOIN semantic.identity_epoch_mapping m ON (m.route,m.original,m.control_partition,m.control_group,m.source_revision,m.recorded_transaction_id,m.owner_epoch)=
 (s.route,s.original,s.control_partition,s.terminal,s.source_revision,s.source_transaction_id,s.source_owner_epoch)
JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal,g.generation,g.version,g.owner_epoch)=
 (s.control_partition,s.terminal,s.generation,s.basis_version,s.owner_epoch)
JOIN core.partition o ON o.partition_no=s.route/16 AND o.epoch=s.source_owner_epoch AND o.write_state='active'
JOIN core.partition c ON c.partition_no=s.control_partition AND c.epoch=s.owner_epoch AND c.write_state='active'
LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.original)
LEFT JOIN LATERAL(SELECT target FROM semantic.redirect WHERE (route,subject_id)=(s.route,s.original) ORDER BY sequence DESC LIMIT 1) r ON true
WHERE s.job_id=(SELECT job FROM parameters) AND coalesce(d.revision,0)=coalesce(d.captured_revision,0)
 AND coalesce(r.target,s.original)=s.terminal AND (g.pending_job IS NULL OR g.pending_job=(SELECT job FROM parameters));
