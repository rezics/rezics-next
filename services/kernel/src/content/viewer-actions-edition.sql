-- Two independent batches, with no joins between their partitions.
SELECT s.subject_id AS id, s.type, true AS public
FROM unnest(:subject_routes::integer[], :subjects::uuid[]) AS wanted(route,id)
CROSS JOIN LATERAL (
  SELECT subject_id, type FROM semantic.subject
  WHERE route=wanted.route AND subject_id=wanted.id AND visibility='visible' LIMIT 1
) s
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  WHERE route=wanted.route AND subject_id=wanted.id ORDER BY sequence DESC LIMIT 1
) redirect ON true
WHERE redirect.target IS NULL
UNION ALL
SELECT a.account_id, 'access.account', false
FROM unnest(:creator_routes::integer[], :creators::uuid[]) AS wanted(route,id)
CROSS JOIN LATERAL (
  SELECT account_id FROM access.account
  WHERE route=wanted.route AND account_id=wanted.id AND state='active' LIMIT 1
) a
WHERE NOT EXISTS (
  SELECT 1 FROM content.erasure_fence f
  WHERE f.route=wanted.route AND f.account_id=wanted.id AND f.closed_at IS NOT NULL LIMIT 1
);
