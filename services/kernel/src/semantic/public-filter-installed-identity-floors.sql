-- A missing floor is still a dependency of an existing release. Keep that outcome
-- distinct from the missing base release, for which the caller resolves composite meaning.
SELECT floors.id, floors.visible, floors.revision
FROM core.partition home JOIN semantic.definition_release release ON release.route = 0
LEFT JOIN LATERAL (
  SELECT s.subject_id::text AS id, s.visibility = 'visible' AS visible, s.security_revision::text AS revision
  FROM unnest(:routes::integer[], :ids::uuid[]) AS wanted(route, id)
  CROSS JOIN LATERAL (
    SELECT subject_id, visibility, security_revision FROM semantic.subject
    WHERE (route, subject_id) = (wanted.route, wanted.id) LIMIT 1
  ) s
) floors ON true
WHERE home.partition_no = 0 AND home.write_state = 'active' AND release.digest = :digest::text;
