SELECT d.route, d.original::text, d.terminal::text, d.revision::text AS source_revision,
       m.member_id IS NOT NULL AS present
FROM semantic.identity_epoch_member_dirty d
LEFT JOIN semantic.merge_member m ON (m.route,m.subject_id,m.member_id)=(d.route,d.terminal,d.original)
WHERE d.route BETWEEN :first_route::integer AND :last_route::integer
  AND d.revision > d.captured_revision
ORDER BY d.route,d.terminal,d.original LIMIT 100
FOR UPDATE OF d;
