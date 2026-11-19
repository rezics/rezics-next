-- Each row belongs to the requested Subject, its active home and that home's privacy head.
SELECT s.route, s.subject_id::text AS id, s.type, s.visibility, s.security_revision::text AS "securityRevision",
       s.current_release AS "currentRelease", redirect.target::text AS redirect,
       COALESCE(state.ready, false) AS selection_ready, revision.revision AS current_revision,
       home.epoch, privacy.position::text AS privacy_position
FROM unnest(:routes::integer[], :ids::uuid[]) AS wanted(route, id)
CROSS JOIN LATERAL (
  SELECT epoch FROM core.partition WHERE partition_no = wanted.route / 16 AND write_state = 'active' LIMIT 1
) home
CROSS JOIN LATERAL (
  SELECT position FROM semantic.public_filter_privacy_head WHERE partition_no = wanted.route / 16 LIMIT 1
) privacy
CROSS JOIN LATERAL (
  SELECT route, subject_id, type, visibility, security_revision, current_release
  FROM semantic.subject WHERE (route, subject_id) = (wanted.route, wanted.id) LIMIT 1
) s
LEFT JOIN LATERAL (
  SELECT ready FROM semantic.search_selection_state WHERE (route, subject_id) = (s.route, s.subject_id) LIMIT 1
) state ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect WHERE (route, subject_id) = (s.route, s.subject_id)
  ORDER BY sequence DESC LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT revision FROM semantic.revision WHERE (route, subject_id) = (s.route, s.subject_id)
  ORDER BY revision DESC LIMIT 1
) revision ON true;
