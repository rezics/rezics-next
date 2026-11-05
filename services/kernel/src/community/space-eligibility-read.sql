-- Same active identity/exact head and T predicates as space-read.sql. Eligibility
-- compares only head and lifecycle; do not fetch the unbounded address text.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
), identity AS MATERIALIZED (
  SELECT h.route, h.space_id, h.lifecycle_version, h.head_revision_id, h.created_at, i.at
  FROM community.space h CROSS JOIN input i
  WHERE h.route = i.route AND h.space_id = i.id AND h.state = 'active'
)
SELECT s.head_revision_id, s.lifecycle_version::text
FROM identity s CROSS JOIN input i
JOIN community.space_revision r
  ON r.route = i.route AND r.space_id = s.space_id AND r.revision_id = s.head_revision_id
WHERE s.created_at <= s.at AND r.created_at <= s.at
LIMIT 1;
