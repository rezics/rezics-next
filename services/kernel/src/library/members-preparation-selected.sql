-- Called only inside SelectedInvocation.apply/failure. SDK coordinates are lookup data.
-- History independently holds and verifies this exact native selection before and after the body.
WITH selected AS MATERIALIZED (
  SELECT h.route, h.owner_account_id, h.collection_id, h.episode_id, s.workflow_id, s.function_id
  FROM library.members_preparation AS h
  JOIN core.operational_work_selection AS s
    ON s.partition_no = (h.route >> 4) AND s.workflow_id = :workflow_id::text
    AND s.function_id = :function_id::integer
    AND s.route = h.route AND s.owner_account_id = h.owner_account_id
    AND s.collection_id = h.collection_id AND s.episode_id = h.episode_id
    AND s.custody_id = h.original_custody_id
  WHERE h.route = :route::integer AND h.owner_account_id = :owner_account_id::uuid
    AND h.collection_id = :collection_id::uuid AND h.episode_id = :episode_id::uuid
    AND h.state = 'live' AND s.result IS NULL
    AND s.selected_tuple->>'version' = h.progress_version::text
    AND s.selected_tuple->>'basis' = h.canonical_basis
    AND s.selected_tuple->>'digest' = encode(h.basis_digest, 'hex')
    AND s.selected_tuple->>'reservedIncarnation' = h.reserved_incarnation
    AND s.selected_tuple->>'reservedGeneration' = h.reserved_generation::text
  FOR SHARE OF s FOR UPDATE OF h
)
UPDATE library.members_preparation AS h
SET selected_workflow_id = s.workflow_id, selected_function_id = s.function_id
FROM selected AS s
WHERE h.route = s.route AND h.owner_account_id = s.owner_account_id
  AND h.collection_id = s.collection_id AND h.episode_id = s.episode_id
RETURNING true AS associated;
