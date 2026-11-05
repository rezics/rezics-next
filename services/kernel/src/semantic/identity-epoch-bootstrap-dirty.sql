SELECT d.route, d.original::text, coalesce(r.target,d.original)::text AS terminal,
       d.revision::text AS source_revision, s.subject_id IS NOT NULL AS present,
       b.control_partition AS previous_partition,b.control_group::text AS previous_terminal
FROM semantic.identity_epoch_dirty d
LEFT JOIN semantic.subject s ON (s.route,s.subject_id)=(d.route,d.original)
LEFT JOIN semantic.identity_epoch_mapping b ON (b.route,b.original)=(d.route,d.original)
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect WHERE route=d.route AND subject_id=d.original
  ORDER BY sequence DESC LIMIT 1
) r ON true
WHERE d.route BETWEEN :first_route::integer AND :last_route::integer
  AND d.revision > d.captured_revision
ORDER BY d.route,d.original LIMIT 100
FOR UPDATE OF d;
