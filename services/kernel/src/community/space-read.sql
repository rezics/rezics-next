-- Materialize the single identity before joining its exact head. Otherwise a
-- reordered join can scan every revision of this Space before checking the head.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
), identity AS MATERIALIZED (
  SELECT h.route, space_id, h.lifecycle_version, state, head_revision_id, created_at, creator,
         h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
         i.at
  FROM community.space AS h CROSS JOIN input i
  WHERE h.route = i.route AND space_id = i.id AND state = 'active'
)
SELECT s.space_id, s.lifecycle_version::text, s.state, s.head_revision_id, s.created_at::text, s.creator,
       r.predecessor, r.address, r.title, r.summary, r.created_at::text AS revision_created_at, r.author,
       s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
FROM identity s
CROSS JOIN input i
JOIN community.space_revision r
  ON r.route = i.route AND r.space_id = s.space_id AND r.revision_id = s.head_revision_id
WHERE s.created_at <= s.at AND r.created_at <= s.at
LIMIT 1;
