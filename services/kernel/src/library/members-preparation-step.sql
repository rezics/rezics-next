SELECT h.canonical_basis AS basis, h.progress_version::text AS version, h.checkpoint, h.observation,
       h.source_incarnation AS "preparedIncarnation", h.source_generation::text AS "preparedGeneration",
       h.complete, h.source_exhausted AS "sourceExhausted", c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text AS incarnation,
       c.source_generation::text AS generation
FROM library.members_preparation AS h, library.collection AS c
WHERE h.route = :route::integer AND h.owner_account_id = :owner_account_id::uuid
  AND h.collection_id = :collection_id::uuid AND h.episode_id = :episode_id::uuid
  AND h.state = 'live' AND h.last_read_at > :at::timestamptz - interval '24 hours'
  AND c.route = h.route AND c.collection_id = h.collection_id AND c.curator_account_id = h.owner_account_id
  AND h.reserved_incarnation = c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text
  AND h.reserved_generation = c.source_generation::text
  AND c.state = 'active' AND c.membership_kind = 'curated'
FOR SHARE OF c FOR UPDATE OF h;
