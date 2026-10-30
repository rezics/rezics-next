SELECT profile_migration_phase AS phase, profile_migration_digest AS digest,
       profile_migration_after::text AS after
FROM library.fact_source_head
WHERE route = :route::integer AND account_id = :account_id::uuid;
