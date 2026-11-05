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
SET count = stored.count + :update_delta::integer,
    source_epoch = GREATEST(stored.source_epoch, EXCLUDED.source_epoch),
    source_position = CASE WHEN stored.source_epoch > EXCLUDED.source_epoch THEN stored.source_position
      WHEN stored.source_epoch < EXCLUDED.source_epoch THEN EXCLUDED.source_position
      ELSE GREATEST(stored.source_position, EXCLUDED.source_position) END
RETURNING WITH (OLD AS previous, NEW AS current)
  COALESCE(previous.count, 0) AS previous_count,
  current.count AS current_count;
