-- A partial child drain still advances the exact selected version and retains explicit repair progress.
UPDATE library.members_preparation
SET progress_version = progress_version + 1, checkpoint = '{"repair":true}', observation = NULL,
    source_incarnation = NULL, source_generation = NULL, complete = false, source_exhausted = false,
    failure_code = NULL
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid
  AND collection_id = :collection_id::uuid AND episode_id = :episode_id::uuid
  AND state = 'live' AND progress_version = :version::bigint
RETURNING progress_version::text AS version;
