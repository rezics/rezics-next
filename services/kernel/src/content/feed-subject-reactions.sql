-- Selected identities only. The latest redirect is a bounded native prefix seek;
-- never follow it and attach the survivor's slot to the original card.
WITH input AS NOT MATERIALIZED (
  SELECT :partition::integer AS partition_no
)
SELECT requested.id::text AS id, subject.type,
       subject.security_revision::text AS "securityRevision",
       redirect.target::text AS redirect
FROM unnest(:ids::uuid[], :routes::integer[]) AS requested(id, route)
CROSS JOIN input
JOIN LATERAL (
  SELECT s.type, s.security_revision FROM semantic.subject s
  WHERE s.route = requested.route AND s.subject_id = requested.id
    AND s.visibility = 'visible'
    AND s.route >= input.partition_no * 16 AND s.route < (input.partition_no + 1) * 16
  LIMIT 1
) AS subject ON true
LEFT JOIN LATERAL (
  SELECT r.target FROM semantic.redirect r
  WHERE r.route = requested.route AND r.subject_id = requested.id
    AND r.route >= input.partition_no * 16 AND r.route < (input.partition_no + 1) * 16
  ORDER BY r.sequence DESC LIMIT 1
) AS redirect ON true;
