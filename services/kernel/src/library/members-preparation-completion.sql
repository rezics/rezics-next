-- Exact indexed native result point. A header Boolean, request receipt or SDK SUCCESS is insufficient.
SELECT true AS complete
FROM library.members_preparation AS h
JOIN core.operational_work_selection AS s
  ON s.partition_no = (h.route >> 4) AND s.workflow_id = h.selected_workflow_id
  AND s.function_id = h.selected_function_id
  AND s.route = h.route AND s.owner_account_id = h.owner_account_id
  AND s.collection_id = h.collection_id AND s.episode_id = h.episode_id
  AND s.custody_id = h.original_custody_id
JOIN core.operational_work_original AS o
  ON o.partition_no = s.partition_no AND o.custody_id = s.custody_id
WHERE h.route = :route::integer AND h.owner_account_id = :owner_account_id::uuid
  AND h.collection_id = :collection_id::uuid AND h.episode_id = :episode_id::uuid
  AND h.state = 'live' AND h.complete AND h.source_exhausted AND h.failure_code IS NULL
  AND s.original_digest = o.request_digest AND o.sealed
  AND s.restore_generation::text = o.sdk_writer->>'restoreGeneration'
  AND s.result->>'kind' = 'complete' AND s.result->>'version' = h.progress_version::text
  AND s.selected_tuple->>'basis' = h.canonical_basis
  AND s.selected_tuple->>'digest' = encode(h.basis_digest, 'hex')
  AND s.selected_tuple->>'reservedIncarnation' = h.reserved_incarnation
  AND s.selected_tuple->>'reservedGeneration' = h.reserved_generation::text;
