-- Keep exact-release opinion heads distinct from MainVersion heads in Access.
-- The nullable column preserves existing MainVersion-grain rows.
ALTER TABLE access.rating_aggregate_head
  ADD COLUMN target_release text
  CHECK (target_release IS NULL OR target_release ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$');

CREATE INDEX rating_aggregate_head_release
  ON access.rating_aggregate_head (context, target_release, slot)
  WHERE target_release IS NOT NULL;
