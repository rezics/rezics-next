-- Legacy Open Library conversions keep their original field inventory vocabulary.
-- This one explicit native target permits a retained description to support a
-- separately accepted synopsis; it does not auto-apply source expression.
SET CONSTRAINTS source.source_field_mapping_sealed IMMEDIATE;
DO $$
DECLARE legacy_guard text;
BEGIN
  SELECT conname INTO legacy_guard FROM pg_constraint
    WHERE conrelid = 'source.field_mapping'::regclass
      AND pg_get_constraintdef(oid) LIKE '%open-library-work-map-v1%';
  IF legacy_guard IS NULL THEN RAISE EXCEPTION 'legacy mapping guard is unavailable'; END IF;
  EXECUTE format('ALTER TABLE source.field_mapping DROP CONSTRAINT %I', legacy_guard);
END $$;
SET CONSTRAINTS source.source_field_mapping_sealed DEFERRED;
INSERT INTO source.field_mapping (mapping_revision, provider, namespace, root_grain, field_count)
VALUES ('open-library-work-map-v1', 'open-library', 'work', 'work', 1);
INSERT INTO source.field_disposition (mapping_revision, grain, field_key, disposition,
  value_kind, reason, native_target)
VALUES ('open-library-work-map-v1', 'work', 'description', 'native', 'text',
  'Native synopsis requires explicit edit control; source rights remain undetermined',
  'work-editorial-field-v1#synopsis');
