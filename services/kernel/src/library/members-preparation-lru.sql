SELECT collection_id AS "collectionId", episode_id AS "episodeId"
FROM library.members_preparation
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid AND state = 'live'
  AND NOT (basis_digest = ANY(:digests::bytea[]))
ORDER BY last_read_at, episode_id
LIMIT :limit::integer;
