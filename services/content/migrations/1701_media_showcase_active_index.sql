-- migrate: concurrent-index media.selection_showcase_active_idx
CREATE INDEX CONCURRENTLY selection_showcase_active_idx ON media.selection_slot (target, context, role)
  WHERE role LIKE 'showcase-%' AND showcase_active;
