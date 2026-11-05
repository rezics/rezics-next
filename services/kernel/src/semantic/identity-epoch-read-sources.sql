SELECT s.subject_id,m.*,coalesce(d.revision,0) dirty_revision,coalesce(d.captured_revision,0) captured_revision,
  r.target current_target
FROM unnest($1::uuid[],$2::integer[]) requested(original,route)
JOIN LATERAL(SELECT * FROM semantic.subject WHERE (route,subject_id)=(requested.route,requested.original) LIMIT 1) s ON true
LEFT JOIN LATERAL(SELECT * FROM semantic.identity_epoch_mapping WHERE (route,original)=(s.route,s.subject_id) LIMIT 1) m ON true
LEFT JOIN LATERAL(SELECT * FROM semantic.identity_epoch_dirty WHERE (route,original)=(s.route,s.subject_id) LIMIT 1) d ON true
LEFT JOIN LATERAL(SELECT target FROM semantic.redirect WHERE route=s.route AND subject_id=s.subject_id ORDER BY sequence DESC LIMIT 1) r ON true;
