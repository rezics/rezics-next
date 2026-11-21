-- migrate:up
-- Each proof binds at most one original receiver. Keep its parameterized native
-- plan on this backend and use the receiver keys even for small, mixed-age tables.
-- These function-local settings are restored when each call returns.
ALTER FUNCTION semantic.public_filter_published_coverage(text,text,uuid,uuid,text[])
  ROWS 1 SET plan_cache_mode=force_generic_plan SET join_collapse_limit=1 SET enable_seqscan=off;
ALTER FUNCTION semantic.public_filter_ack_origin(text,uuid)
  SET plan_cache_mode=force_generic_plan SET join_collapse_limit=1 SET enable_seqscan=off;

-- migrate:down
ALTER FUNCTION semantic.public_filter_ack_origin(text,uuid)
  RESET plan_cache_mode RESET join_collapse_limit RESET enable_seqscan;
ALTER FUNCTION semantic.public_filter_published_coverage(text,text,uuid,uuid,text[])
  ROWS 1000 RESET plan_cache_mode RESET join_collapse_limit RESET enable_seqscan;
