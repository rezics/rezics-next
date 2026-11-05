UPDATE library.members_preparation AS h
SET progress_version = h.progress_version + 1, checkpoint = NULL, observation = NULL,
    source_incarnation = NULL, source_generation = NULL, next_position = 0, result_count = 0, complete = false, source_exhausted = false, failure_code = NULL
WHERE h.route = :route::integer AND h.owner_account_id = :owner_account_id::uuid
  AND h.collection_id = :collection_id::uuid AND h.episode_id = :episode_id::uuid
  AND h.state = 'live' AND h.progress_version = :version::bigint
  AND NOT EXISTS (SELECT 1 FROM library.members_preparation_result AS r
    WHERE r.route = h.route AND r.owner_account_id = h.owner_account_id
      AND r.collection_id = h.collection_id AND r.episode_id = h.episode_id)
RETURNING h.progress_version::text AS version;
