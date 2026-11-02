UPDATE library.members_preparation
SET failure_code = :failure::text
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid
  AND collection_id = :collection_id::uuid AND episode_id = :episode_id::uuid
  AND state = 'live' AND progress_version = :version::bigint
  AND last_read_at > :at::timestamptz - interval '24 hours'
RETURNING true AS recorded;
