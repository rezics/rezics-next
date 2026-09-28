-- A Work's expressive body can have a rights assessment before its first
-- Content variant exists. Preserve every earlier material scope and identity.
ALTER TABLE rights.material ADD COLUMN work_id text
  CHECK (work_id IS NULL OR work_id ~ '^https://rezics.com/id/[0-9a-f-]{36}$');
ALTER TABLE rights.material DROP CONSTRAINT material_scope_kind_check;
ALTER TABLE rights.material ADD CONSTRAINT material_scope_kind_check CHECK (scope_kind IN
  ('source_provider', 'source_record', 'content_variant', 'media_asset', 'work'));
ALTER TABLE rights.material ADD CONSTRAINT material_work_scope_check
  CHECK ((scope_kind = 'work') = (work_id IS NOT NULL));
DROP INDEX rights.material_scope_idx;
CREATE UNIQUE INDEX material_scope_idx ON rights.material
  (scope_kind, provider, namespace, source_record_id, content_variant_id, media_asset, work_id, component)
  NULLS NOT DISTINCT;
CREATE INDEX material_work_idx ON rights.material (work_id, component)
  WHERE work_id IS NOT NULL;
