WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
UPDATE library.members_preparation AS h
SET last_read_at = GREATEST(last_read_at, (SELECT at FROM input))
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid
  AND collection_id = :collection_id::uuid AND episode_id = :episode_id::uuid
  AND EXISTS (SELECT 1 FROM library.collection c WHERE c.route = h.route AND c.collection_id = h.collection_id
    AND h.reserved_incarnation = c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text
    AND h.reserved_generation = c.source_generation::text)
  AND state = 'live' AND last_read_at > (SELECT at FROM input) - interval '24 hours'
RETURNING true AS touched;
