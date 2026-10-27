-- The candidate's exact current head supplies its canonical address and modification time.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
), identity AS MATERIALIZED (
  SELECT h.route, h.space_id, h.head_revision_id, h.created_at, i.at
  FROM community.space AS h CROSS JOIN input i
  WHERE h.route = i.route AND h.space_id = i.id
    AND h.state = 'active' AND h.created_at <= i.at
)
SELECT r.address,
       to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision_created_at
FROM identity AS h CROSS JOIN input i
JOIN community.space_revision AS r
  ON r.route = i.route AND r.space_id = h.space_id AND r.revision_id = h.head_revision_id
WHERE r.created_at <= h.at
LIMIT 1;
