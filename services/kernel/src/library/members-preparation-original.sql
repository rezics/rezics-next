-- Later native work independently validates the delivered association; no transfer is reconstructed.
SELECT h.original_custody_id::text AS "custodyId", h.original_transaction_id::text AS "transactionId",
       h.original_epoch AS epoch, h.original_generation::text AS generation, h.original_position::text AS position
FROM library.members_preparation AS h
JOIN core.operational_work_original AS o
  ON o.partition_no = (h.route >> 4) AND o.custody_id = h.original_custody_id
JOIN core.operational_work_episode AS e
  ON e.partition_no = o.partition_no AND e.custody_id = o.custody_id AND e.route = h.route
  AND e.owner_account_id = h.owner_account_id AND e.collection_id = h.collection_id AND e.episode_id = h.episode_id
JOIN core.partition AS p ON p.partition_no = o.partition_no AND p.write_state = 'active'
JOIN core.history_family_domain AS d ON d.singleton AND d.generation = o.source_generation
WHERE h.route = :route::integer AND h.owner_account_id = :owner_account_id::uuid
  AND h.collection_id = :collection_id::uuid AND h.episode_id = :episode_id::uuid AND h.state = 'live'
  AND h.original_transaction_id = o.transaction_id AND h.original_epoch = o.source_epoch AND p.epoch = o.source_epoch
  AND h.original_generation = o.source_generation AND h.original_position = o.source_position
  AND o.operation_mode = 'request' AND o.operation_accounts = jsonb_build_array(h.owner_account_id::text)
  AND o.sealed AND o.source_domain = 'operational-work/v1' AND o.operation_kind = 'library.membersPreparation'
  AND o.binding->>'route' = h.route::text AND o.binding->>'ownerAccountId' = h.owner_account_id::text
  AND o.binding->>'collectionId' = h.collection_id::text AND o.workflow_id = h.workflow_id
  AND o.binding->'episodes' @> jsonb_build_array(jsonb_build_object(
    'collectionId',h.collection_id,'episodeId',h.episode_id,'reservedIncarnation',h.reserved_incarnation,
    'reservedGeneration',h.reserved_generation::text,'canonicalBasis',h.canonical_basis,'basisDigest',encode(h.basis_digest,'hex')));
