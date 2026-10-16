-- Provider adapters supply values, while the same sealed dispositions govern
-- attachment, adoption and synopsis application. No source rights are inferred.
INSERT INTO source.field_mapping (mapping_revision, provider, namespace, root_grain, field_count)
VALUES ('bangumi-subject-map-v1', 'bangumi', 'subject', 'subject', 5);
INSERT INTO source.field_disposition
  (mapping_revision, grain, field_key, disposition, value_kind, reason, native_target)
SELECT 'bangumi-subject-map-v1', 'subject', field, disposition, kind,
  'Retained provider evidence requires explicit native acceptance; rights remain undetermined', target
FROM (VALUES
  ('id', 'structured-source-only', 'identifier', NULL),
  ('name', 'native', 'text', 'work-metadata-v1#title:en'),
  ('type', 'native', 'term', 'work-metadata-v1#semantic-types'),
  ('summary', 'native', 'text', 'work-editorial-field-v1#synopsis'),
  ('tags', 'native', 'term', 'work-native-child-v1#tags')
) AS fields(field, disposition, kind, target);
