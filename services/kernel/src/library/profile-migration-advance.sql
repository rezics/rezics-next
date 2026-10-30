UPDATE library.fact_source_head
SET profile_migration_phase = :phase::text, profile_migration_digest = :digest::text,
    profile_migration_after = :after::nullable(uuid)
WHERE route = :route::integer AND account_id = :account_id::uuid;
