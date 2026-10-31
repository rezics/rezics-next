-- migrate:up
-- The inverse is candidate-only. Seek only live supports, including when stale zero rows accumulate.
CREATE INDEX follow_activity_recipients ON library.follow_count_support(route,target_type,target_id,account_id) WHERE support>0;
-- migrate:down
DROP INDEX library.follow_activity_recipients;
