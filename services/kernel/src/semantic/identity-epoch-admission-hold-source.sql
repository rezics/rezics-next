SELECT s.original FROM jsonb_to_recordset($1::jsonb) s(original uuid,route integer,control_partition integer,terminal uuid,source_revision bigint,source_transaction_id uuid,source_owner_epoch integer)
JOIN semantic.identity_epoch_mapping m ON (m.route,m.original,m.control_partition,m.control_group,m.source_revision,m.recorded_transaction_id,m.owner_epoch)=
 (s.route,s.original,s.control_partition,s.terminal,s.source_revision,s.source_transaction_id,s.source_owner_epoch)
JOIN core.partition o ON o.partition_no=$2 AND o.epoch=s.source_owner_epoch AND o.write_state='active'
LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.original)
LEFT JOIN LATERAL(SELECT target FROM semantic.redirect WHERE (route,subject_id)=(s.route,s.original) ORDER BY sequence DESC LIMIT 1) r ON true
WHERE s.route/16=$2 AND coalesce(d.revision,0)=coalesce(d.captured_revision,0) AND coalesce(r.target,s.original)=s.terminal;
