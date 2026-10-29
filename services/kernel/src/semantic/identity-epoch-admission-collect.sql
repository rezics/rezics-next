SELECT g.*,m.original AS input_original,m.route AS source_route,m.source_revision,m.recorded_transaction_id AS source_transaction_id,o.epoch AS source_owner_epoch
FROM unnest($1::uuid[],$2::integer[]) requested(original,route)
JOIN semantic.subject s ON (s.route,s.subject_id)=(requested.route,requested.original)
JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(s.route,s.subject_id)
JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal)=(m.control_partition,m.control_group)
JOIN core.partition p ON p.partition_no=g.partition_no AND p.epoch=g.owner_epoch AND p.write_state='active'
JOIN core.partition o ON o.partition_no=s.route/16 AND o.epoch=m.owner_epoch AND o.write_state='active'
LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.subject_id)
LEFT JOIN LATERAL(SELECT target FROM semantic.redirect WHERE (route,subject_id)=(s.route,s.subject_id) ORDER BY sequence DESC LIMIT 1) r ON true
WHERE coalesce(d.revision,0)=coalesce(d.captured_revision,0)
AND coalesce(r.target,s.subject_id)=m.control_group;
