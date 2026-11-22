-- migrate:up
-- The mixed receiver returns a single exact proof. Keep its bounded join plan on
-- each backend through capture, privacy START, FINAL and cursor continuation.
ALTER FUNCTION semantic.public_filter_mixed_coverage(text,text,uuid,uuid,text)
  ROWS 1 SET plan_cache_mode=force_generic_plan SET join_collapse_limit=1 SET enable_seqscan=off;

-- migrate:down
ALTER FUNCTION semantic.public_filter_mixed_coverage(text,text,uuid,uuid,text)
  ROWS 1000 RESET plan_cache_mode RESET join_collapse_limit RESET enable_seqscan;
