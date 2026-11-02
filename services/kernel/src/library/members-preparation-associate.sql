-- SAME native reservation transaction. The History original is unsealed until Core's finalizer.
WITH input AS (
  SELECT :partition::integer AS partition, :custody_id::uuid AS custody_id,
         :route::integer AS route, :owner_account_id::uuid AS owner_account_id,
         :collection_id::uuid AS collection_id, :episodes::uuid[] AS episodes
), original AS MATERIALIZED (
  SELECT o.custody_id, o.transaction_id, o.source_domain, o.source_generation, o.source_position, p.epoch, o.binding
  FROM core.operational_work_original AS o
  JOIN core.partition AS p ON p.partition_no = o.partition_no AND p.write_state = 'active'
  CROSS JOIN input AS i
  WHERE o.partition_no = i.partition AND o.custody_id = i.custody_id
    AND o.operation_kind = 'library.membersPreparation' AND o.operation_mode = 'request'
    AND o.source_domain = 'operational-work/v1' AND o.source_position IS NOT NULL AND NOT o.sealed
    AND o.binding->>'route' = i.route::text
    AND o.binding->>'ownerAccountId' = i.owner_account_id::text
    AND o.binding->>'collectionId' = i.collection_id::text
  FOR SHARE OF o, p
), episodes AS MATERIALIZED (
  SELECT e.* FROM original, jsonb_to_recordset(original.binding->'episodes') AS e(
    "collectionId" uuid, "episodeId" uuid, "reservedIncarnation" text, "reservedGeneration" text,
    "canonicalBasis" text, "basisDigest" text)
)
UPDATE library.members_preparation AS h
SET original_custody_id = o.custody_id, original_transaction_id = o.transaction_id,
    original_epoch = o.epoch, original_generation = o.source_generation, original_position = o.source_position
FROM original AS o, episodes AS e, core.operational_work_episode AS association, input AS i
WHERE h.route = i.route AND h.owner_account_id = i.owner_account_id
  AND h.collection_id = i.collection_id AND h.episode_id = ANY(i.episodes)
  AND association.partition_no = i.partition AND association.custody_id = o.custody_id
  AND association.route = h.route AND association.owner_account_id = h.owner_account_id
  AND association.collection_id = h.collection_id AND association.episode_id = h.episode_id
  AND h.collection_id = e."collectionId" AND h.episode_id = e."episodeId"
  AND h.reserved_incarnation = e."reservedIncarnation" AND h.reserved_generation::text = e."reservedGeneration"
  AND h.canonical_basis = e."canonicalBasis" AND encode(h.basis_digest, 'hex') = e."basisDigest"
  AND h.state = 'live' AND h.original_custody_id IS NULL
RETURNING h.episode_id AS "episodeId";
