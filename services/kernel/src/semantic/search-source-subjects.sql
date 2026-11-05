WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
),
requested AS MATERIALIZED (
  SELECT ids.route, ids.subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS ids(route, subject_id)
  CROSS JOIN input
  WHERE ids.route / 16 = input.partition_no
)
SELECT s.route,
       s.subject_id::text AS id,
       s.type,
       s.visibility,
       s.security_revision::text AS "securityRevision",
       s.current_release AS "currentRelease",
       redirect.target::text AS redirect,
       COALESCE(state.ready, false) AS selection_ready,
       revision.revision AS current_revision
FROM requested
CROSS JOIN input
JOIN LATERAL (
  SELECT subject.route, subject.subject_id, subject.type, subject.visibility,
         subject.security_revision, subject.current_release
  FROM semantic.subject subject
  CROSS JOIN input
  WHERE subject.route = requested.route AND subject.subject_id = requested.subject_id
    AND subject.route >= input.partition_no * 16
    AND subject.route < (input.partition_no + 1) * 16
  LIMIT 1
) s ON true
LEFT JOIN semantic.search_selection_state state ON state.route = s.route AND state.subject_id = s.subject_id
  AND state.route >= input.partition_no * 16 AND state.route < (input.partition_no + 1) * 16
LEFT JOIN LATERAL (
  SELECT target
  FROM semantic.redirect
  CROSS JOIN input
  WHERE route = s.route AND subject_id = s.subject_id
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  ORDER BY sequence DESC
  LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT revision FROM semantic.revision v
  WHERE v.route = s.route AND v.subject_id = s.subject_id
    AND v.route >= input.partition_no * 16 AND v.route < (input.partition_no + 1) * 16
  ORDER BY revision DESC LIMIT 1
) revision ON true;

