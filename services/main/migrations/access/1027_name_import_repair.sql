-- Keep the import evidence after cleanup removes the graph naming projection.
-- Older reports recover their evidence from retained owner revisions on retry.
ALTER TABLE access.name_graph_import_report
  ADD COLUMN legacy_name jsonb,
  ADD COLUMN attempted_at timestamptz,
  ADD COLUMN repaired_at timestamptz;
CREATE INDEX name_graph_import_pending ON access.name_graph_import_report(data_epoch,source)
  WHERE repaired_at IS NULL;
