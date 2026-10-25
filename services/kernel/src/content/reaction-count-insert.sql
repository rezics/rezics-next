INSERT INTO content.reaction_count
  (route, target_id, source_partition, kind, count, source_epoch, source_position)
VALUES (
  :route::integer,
  :target_id::uuid,
  :source_partition::integer,
  :kind::text,
  GREATEST(:delta::integer, 0),
  :source_epoch::integer,
  :source_position::bigint
)
ON CONFLICT (route, target_id, source_partition, kind) DO NOTHING;
