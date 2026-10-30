-- Materialize the single identity before joining its exact head. Otherwise a
-- reordered join can scan every revision of this Realm before checking the head.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
), identity AS MATERIALIZED (
  SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,
         ownership_state, orphaned_at, claim_eligible_at,
         h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
         i.at
  FROM community.realm AS h CROSS JOIN input i
  WHERE h.route = i.route AND realm_id = i.id AND state = 'active'
    AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')
)
SELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,
       s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,
       r.created_at::text AS revision_created_at, r.author,
       s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
FROM identity s
CROSS JOIN input i
JOIN community.realm_revision r
  ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id
WHERE s.created_at <= s.at AND r.created_at <= s.at
LIMIT 1;
