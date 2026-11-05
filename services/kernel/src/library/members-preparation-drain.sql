WITH args AS NOT MATERIALIZED (SELECT :route::integer AS route, :owner_account_id::uuid AS owner_account_id, :collection_id::uuid AS collection_id, :episode_id::uuid AS episode_id)
DELETE FROM library.members_preparation
WHERE route = (SELECT route FROM args) AND owner_account_id = (SELECT owner_account_id FROM args)
  AND collection_id = (SELECT collection_id FROM args) AND episode_id = (SELECT episode_id FROM args) AND state = 'retired'
  AND NOT EXISTS (SELECT 1 FROM library.members_preparation_result AS r
    WHERE r.route = (SELECT route FROM args) AND r.owner_account_id = (SELECT owner_account_id FROM args)
      AND r.collection_id = (SELECT collection_id FROM args) AND r.episode_id = (SELECT episode_id FROM args))
RETURNING true AS removed;
