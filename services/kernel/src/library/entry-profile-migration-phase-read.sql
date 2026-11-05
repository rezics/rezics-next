SELECT profile_migration_phase AS phase
FROM library.fact_source_head
WHERE route = :route::integer AND account_id = :account_id::uuid;
