SELECT collection_id AS "collectionId", episode_id AS "episodeId", canonical_basis AS basis,
       encode(basis_digest, 'hex') AS digest, workflow_id AS "workflowId",
       (h.last_read_at <= :at::timestamptz - interval '24 hours' OR NOT EXISTS (
         SELECT 1 FROM library.collection c WHERE c.route = h.route AND c.collection_id = h.collection_id
         AND h.reserved_incarnation = c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text
         AND h.reserved_generation = c.source_generation::text)) AS expired
FROM library.members_preparation h
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid AND state = 'live'
  AND basis_digest = ANY(:digests::bytea[]);
