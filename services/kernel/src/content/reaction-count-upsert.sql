INSERT INTO content.reaction_count AS stored
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
ON CONFLICT (route, target_id, source_partition, kind) DO UPDATE
SET count = GREATEST(stored.count + :update_delta::integer, 0),
    source_epoch = EXCLUDED.source_epoch,
    source_position = EXCLUDED.source_position
WHERE (stored.source_epoch, stored.source_position) < (EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING WITH (OLD AS previous, NEW AS current)
  COALESCE(previous.count, 0) AS previous_count,
  current.count AS current_count;
