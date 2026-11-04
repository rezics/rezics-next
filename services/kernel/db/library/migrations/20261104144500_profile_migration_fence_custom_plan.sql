-- migrate:up
-- The writer fence's pending-pin EXISTS probes already have partial indexes. A generic
-- PL/pgSQL plan still seq-scans owner Sessions once the heap exceeds the tiny-page limit.
ALTER FUNCTION library.fence_profile_migration_writer() SET plan_cache_mode = force_custom_plan;

-- migrate:down
-- Forward only: restoring generic plans seq-scans pinned owner Sessions on every live write.
