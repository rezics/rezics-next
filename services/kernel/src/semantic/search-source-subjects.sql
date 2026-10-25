WITH requested AS MATERIALIZED (
  SELECT input.route, input.subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS input(route, subject_id)
  WHERE input.route / 16 = :partition_no::integer
)
SELECT s.route,
       s.subject_id::text AS id,
       s.type,
       s.visibility,
       s.security_revision::text AS "securityRevision",
       s.current_release AS "currentRelease",
       redirect.target::text AS redirect
FROM requested input
JOIN LATERAL (
  SELECT subject.route, subject.subject_id, subject.type, subject.visibility,
         subject.security_revision, subject.current_release
  FROM semantic.subject subject
  WHERE subject.route = input.route AND subject.subject_id = input.subject_id
  LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT target
  FROM semantic.redirect
  WHERE route = s.route AND subject_id = s.subject_id
  ORDER BY sequence DESC
  LIMIT 1
) redirect ON true;
