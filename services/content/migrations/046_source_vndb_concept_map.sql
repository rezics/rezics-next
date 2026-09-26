-- VNDB Kana's elected concept and qualified association fields. A new or omitted
-- field remains explicit in conversion inventory; a score is source data only.
INSERT INTO source.field_mapping (mapping_revision, provider, namespace, root_grain, field_count)
VALUES ('vndb-concept-map-v1', 'vndb', 'vn', 'vn', 31);
INSERT INTO source.field_disposition (mapping_revision, grain, field_key, disposition, value_kind, reason,
  native_target, loss)
SELECT 'vndb-concept-map-v1', grain, field, disposition, kind, reason, target, NULL
FROM (VALUES
  ('vn','id','structured-source-only','identifier','Provider VN ID is not a native Work identity',NULL),
  ('vn','tags','structured-source-only','structure','Source tag occurrence list is qualified',NULL),
  ('vn','tags.id','native','reference','Exact tag ID may support an accepted Statement','statement-v1#classification'),
  ('vn','tags.name','structured-source-only','text','Same label is not concept equivalence',NULL),
  ('vn','tags.rating','structured-source-only','statistic','Provider tag score is not a native ballot',NULL),
  ('vn','tags.spoiler','structured-source-only','metadata','Spoiler qualifies the tag association',NULL),
  ('vn','tags.lie','structured-source-only','metadata','Lie flag qualifies the tag association',NULL),
  ('character','id','structured-source-only','identifier','Provider character ID is not native identity',NULL),
  ('character','name','structured-source-only','text','Provider name is not a native NameRecord',NULL),
  ('character','traits','structured-source-only','structure','Source trait occurrence list is qualified',NULL),
  ('character','traits.id','native','reference','Exact trait ID may support an accepted Statement','statement-v1#classification'),
  ('character','traits.name','structured-source-only','text','Same label is not concept equivalence',NULL),
  ('character','traits.group_id','structured-source-only','identifier','Provider trait group ID is retained',NULL),
  ('character','traits.group_name','structured-source-only','text','Group-qualified display is retained',NULL),
  ('character','traits.spoiler','structured-source-only','metadata','Spoiler qualifies the trait association',NULL),
  ('character','traits.lie','structured-source-only','metadata','Lie flag qualifies the trait association',NULL),
  ('character','vns','structured-source-only','structure','Appearance occurrence list is qualified',NULL),
  ('character','vns.id','native','reference','Exact VN identity may support an appearance','statement-v1#appearance'),
  ('character','vns.release','structured-source-only','structure','Release scope is retained',NULL),
  ('character','vns.release.id','native','reference','Release-specific appearance needs exact release','statement-v1#appearance'),
  ('character','vns.role','structured-source-only','term','Protagonist is not inferred FemaleLead',NULL),
  ('character','vns.spoiler','structured-source-only','metadata','Spoiler qualifies this appearance',NULL),
  ('tag','id','structured-source-only','identifier','Provider tag ID is retained',NULL),
  ('tag','name','native','text','Native concept requires a reviewed definition','classification-proposition-v1#concept'),
  ('tag','description','structured-source-only','text','Source definition retains provenance',NULL),
  ('tag','category','structured-source-only','term','Provider category remains source scoped',NULL),
  ('trait','id','structured-source-only','identifier','Provider trait ID is retained',NULL),
  ('trait','name','native','text','Native concept requires a reviewed definition','classification-proposition-v1#concept'),
  ('trait','description','structured-source-only','text','Source definition retains provenance',NULL),
  ('trait','group_id','structured-source-only','identifier','Provider group ID is retained',NULL),
  ('trait','group_name','structured-source-only','text','Group-qualified display is retained',NULL)
) AS declared(grain, field, disposition, kind, reason, target);
