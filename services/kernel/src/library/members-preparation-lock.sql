WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :owner_account_id::uuid AS owner_account_id, :collection_id::uuid AS collection_id
), current_collection AS MATERIALIZED (
  SELECT c.collection_id FROM library.collection AS c, input
  WHERE c.route = input.route AND c.collection_id = input.collection_id
    AND c.curator_account_id = input.owner_account_id AND c.state = 'active' AND c.membership_kind = 'curated'
  FOR SHARE OF c
), locked_owner AS MATERIALIZED (
  SELECT o.live_count FROM library.members_preparation_owner AS o, input
  WHERE o.route = input.route AND o.owner_account_id = input.owner_account_id
    AND EXISTS (SELECT 1 FROM current_collection)
  FOR UPDATE OF o
)
SELECT (SELECT live_count FROM locked_owner) AS "liveCount"
WHERE EXISTS (SELECT 1 FROM current_collection)
LIMIT 1;
