-- migrate:up
-- Generic PL/pgSQL pending-pin probes seq-scanned pinned owner Sessions at Native512
-- despite the matching partial index. Plan with current parameters inside this fence;
-- custom planning adds planning work and does not guarantee an index scan or bounded access.
ALTER FUNCTION library.fence_profile_migration_writer() SET plan_cache_mode = force_custom_plan;

-- migrate:down
-- Forward only: retain parameter-aware planning for the writer fence.
