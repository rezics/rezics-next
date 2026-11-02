WITH args AS NOT MATERIALIZED (SELECT :collection_id::uuid AS collection_id, :episode_id::uuid AS episode_id),
input AS NOT MATERIALIZED (SELECT :route::integer AS route, :owner_account_id::uuid AS owner_account_id),
retired AS (
  UPDATE library.members_preparation SET state = 'retired'
  WHERE route = (SELECT route FROM input) AND owner_account_id = (SELECT owner_account_id FROM input)
    AND collection_id = (SELECT collection_id FROM args) AND episode_id = (SELECT episode_id FROM args)
    AND state = 'live' AND last_read_at <= :at::timestamptz - interval '24 hours'
  RETURNING episode_id
)
UPDATE library.members_preparation_owner SET live_count = live_count - (SELECT count(*)::integer FROM retired)
WHERE route = (SELECT route FROM input) AND owner_account_id = (SELECT owner_account_id FROM input)
RETURNING (SELECT count(*) FROM retired) > 0 OR EXISTS (
  SELECT 1 FROM library.members_preparation AS h
  WHERE h.route = (SELECT route FROM input) AND h.owner_account_id = (SELECT owner_account_id FROM input)
    AND h.collection_id = (SELECT collection_id FROM args) AND h.episode_id = (SELECT episode_id FROM args) AND h.state = 'retired'
) AS retired;
