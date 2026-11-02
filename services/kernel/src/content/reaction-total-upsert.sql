INSERT INTO content.reaction_total AS stored
  (route, target_id, kind, count, source_epoch, source_position)
VALUES (
  :route::integer,
  :target_id::uuid,
  :kind::text,
  GREATEST(:delta::integer, 0),
  :source_epoch::integer,
  :source_position::bigint
)
ON CONFLICT (route, target_id, kind) DO UPDATE
SET count = stored.count + :update_delta::integer,
    source_epoch = CASE
      WHEN ROW(EXCLUDED.source_epoch, EXCLUDED.source_position) >
           ROW(stored.source_epoch, stored.source_position)
        THEN EXCLUDED.source_epoch
      ELSE stored.source_epoch
    END,
    source_position = CASE
      WHEN ROW(EXCLUDED.source_epoch, EXCLUDED.source_position) >
           ROW(stored.source_epoch, stored.source_position)
        THEN EXCLUDED.source_position
      ELSE stored.source_position
    END;
