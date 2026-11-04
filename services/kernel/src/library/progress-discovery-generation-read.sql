SELECT COALESCE(
  (SELECT generation::text FROM library.progress_discovery_generation
   WHERE route = :route::integer AND account_id = :account_id::uuid),
  '0'
) AS generation;
