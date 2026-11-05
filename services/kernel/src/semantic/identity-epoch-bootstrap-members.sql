SELECT m.route, m.member_id::text AS original, m.subject_id::text AS terminal,
       coalesce(d.revision,0)::text AS source_revision, true AS present
FROM semantic.merge_member m
LEFT JOIN semantic.identity_epoch_member_dirty d ON (d.route,d.terminal,d.original)=(m.route,m.subject_id,m.member_id)
WHERE m.route BETWEEN :first_route::integer AND :last_route::integer
  AND (m.route,m.subject_id,m.member_id) > (:after_route::integer,:after_original::uuid,:after_member::uuid)
ORDER BY m.route,m.subject_id,m.member_id LIMIT 100;
