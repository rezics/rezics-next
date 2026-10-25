-- Materialize the single identity before joining its exact head. Otherwise a
-- reordered join can scan every revision of this Space before checking the head.
WITH identity AS MATERIALIZED (
  SELECT route, space_id, state, head_revision_id, created_at, creator,
         xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
         :at::timestamptz AS at
  FROM community.space
  WHERE route = :route::integer AND space_id = :id::uuid AND state = 'active'
)
SELECT s.space_id, s.state, s.head_revision_id, s.created_at::text, s.creator,
       r.predecessor, r.address, r.title, r.summary, r.created_at::text AS revision_created_at, r.author,
       s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
FROM identity s
JOIN community.space_revision r
  ON r.route = s.route AND r.space_id = s.space_id AND r.revision_id = s.head_revision_id
WHERE s.created_at <= s.at AND r.created_at <= s.at;
