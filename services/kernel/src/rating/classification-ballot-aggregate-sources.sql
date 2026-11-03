SELECT source_partition AS partition, source_epoch AS epoch, source_position::text AS position
FROM rating.classification_aggregate_source
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND association_id = :association_id::uuid AND binding_hash = :binding_hash::bytea
ORDER BY source_partition;
