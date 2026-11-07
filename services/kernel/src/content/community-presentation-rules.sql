-- Bodies are fetched only after native exact-revision and ancestry disclosure.
-- Keys are a JSON array bound as text so the reader never treats the list as a PostgreSQL array.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id FROM jsonb_to_recordset((:keys::text)::jsonb) AS k(route integer, id uuid)
)
SELECT r.revision_id, r.post_id, r.body, r.body_sha256, r.licence
FROM input i
CROSS JOIN LATERAL (
  SELECT r.revision_id, r.post_id, r.body, r.body_sha256, r.licence
  FROM content.revision r
  WHERE r.route = i.route AND r.revision_id = i.id AND r.availability = 'available'
    AND octet_length(r.body) <= 65536
  LIMIT 1
) r;
