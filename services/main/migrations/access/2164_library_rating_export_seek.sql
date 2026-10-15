-- Concatenating Context/target before filtering and sorting defeats an ordered
-- principal seek. Keep the two typed cursor components on the same index.
CREATE INDEX library_rating_export_seek ON access.rating_aggregate_head
  (principal_id,context COLLATE "C",work COLLATE "C") WHERE target_release IS NULL;
CREATE INDEX library_target_rating_export_seek ON access.target_rating_head
  (principal_id,context COLLATE "C",target COLLATE "C");
