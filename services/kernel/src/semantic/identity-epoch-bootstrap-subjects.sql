SELECT s.route, s.subject_id::text AS original, coalesce(r.target,s.subject_id)::text AS terminal,
       coalesce(d.revision,0)::text AS source_revision, true AS present,
       b.control_partition AS previous_partition,b.control_group::text AS previous_terminal
FROM semantic.subject s
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect WHERE route=s.route AND subject_id=s.subject_id
  ORDER BY sequence DESC LIMIT 1
) r ON true
LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.subject_id)
LEFT JOIN semantic.identity_epoch_mapping b ON (b.route,b.original)=(s.route,s.subject_id)
WHERE s.route BETWEEN :first_route::integer AND :last_route::integer
  AND (s.route,s.subject_id) > (:after_route::integer,:after_original::uuid)
ORDER BY s.route,s.subject_id LIMIT 100;
