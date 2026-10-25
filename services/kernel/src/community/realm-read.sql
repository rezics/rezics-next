-- Materialize the single identity before joining its exact head. Otherwise a
-- reordered join can scan every revision of this Realm before checking the head.
WITH identity AS MATERIALIZED (
  SELECT route, realm_id, space_id, visibility, context_id, state, head_revision_id, created_at, creator,
         xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
         :at::timestamptz AS at
  FROM community.realm
  WHERE route = :route::integer AND realm_id = :id::uuid AND state = 'active'
)
SELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.state, s.head_revision_id, s.created_at::text, s.creator,
       r.predecessor, r.title, r.summary, r.created_at::text AS revision_created_at, r.author,
       s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
FROM identity s
JOIN community.realm_revision r
  ON r.route = s.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id
WHERE s.created_at <= s.at AND r.created_at <= s.at;
