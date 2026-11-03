INSERT INTO rating.classification_aggregate_source
  (route, subject_id, association_id, binding_hash, source_partition, source_epoch, source_position)
VALUES (:route::integer, :subject_id::uuid, :association_id::uuid, :binding_hash::bytea,
        :source_partition::integer, :source_epoch::integer, :source_position::bigint)
ON CONFLICT (route, subject_id, association_id, binding_hash, source_partition) DO UPDATE
SET source_epoch = EXCLUDED.source_epoch, source_position = EXCLUDED.source_position
WHERE (rating.classification_aggregate_source.source_epoch, rating.classification_aggregate_source.source_position)
    < (EXCLUDED.source_epoch, EXCLUDED.source_position);
