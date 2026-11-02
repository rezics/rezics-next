WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id),
keys AS MATERIALIZED (
  SELECT collection_id, episode_id FROM library.members_preparation
  WHERE route = (SELECT route FROM input) AND owner_account_id = (SELECT account_id FROM input)
  ORDER BY collection_id, episode_id LIMIT 100
)
DELETE FROM library.members_preparation AS victim USING keys
WHERE victim.route = (SELECT route FROM input) AND victim.owner_account_id = (SELECT account_id FROM input)
  AND victim.collection_id = keys.collection_id AND victim.episode_id = keys.episode_id
  AND NOT EXISTS (SELECT 1 FROM library.members_preparation_result AS r
    WHERE r.route = victim.route AND r.owner_account_id = victim.owner_account_id
      AND r.collection_id = victim.collection_id AND r.episode_id = victim.episode_id)
RETURNING true AS removed;
