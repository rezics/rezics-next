SELECT canonical_basis AS basis, episode_id AS "episodeId", workflow_id AS "workflowId",
       progress_version::text AS version, observation, complete, failure_code AS failure,
       (original_custody_id IS NOT NULL) AS associated, source_incarnation AS incarnation, source_generation::text AS generation
FROM library.members_preparation
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid
  AND collection_id = :collection_id::uuid AND basis_digest = :digest::bytea AND state = 'live'
  AND last_read_at > :at::timestamptz - interval '24 hours';
