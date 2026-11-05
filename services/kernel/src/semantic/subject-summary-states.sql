-- Current native identity and revision fences for a bounded display batch.
WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT s.subject_id::text AS id, s.visibility, s.security_revision::text AS "securityRevision",
       redirect.target::text AS redirect, latest.revision
FROM unnest(:routes::integer[], :subject_ids::uuid[]) requested(route, id)
JOIN LATERAL (
  SELECT subject_id, visibility, security_revision
  FROM semantic.subject
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
  LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
  ORDER BY sequence DESC LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT revision FROM semantic.revision
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
  ORDER BY revision DESC LIMIT 1
) latest ON true;
