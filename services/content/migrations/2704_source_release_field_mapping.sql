-- The new edition/covered-realization correspondence is an explicit mapping
-- revision. Existing v1 inventories and immutable conversion replays stay v1.
INSERT INTO source.field_mapping
  (mapping_revision,provider,namespace,root_grain,field_count,normalization_revision)
SELECT provider || '-release-retained-map-v2',provider,'release','release',0,
  'dataset-record-normalization-v1'
FROM (VALUES ('vndb'),('musicbrainz')) AS mappings(provider);
