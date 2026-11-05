SELECT support_count AS "supportCount", oppose_count AS "opposeCount",
       false_positive_count AS "falsePositiveCount", generation::text AS generation,
       as_of AS "asOf"
FROM rating.classification_aggregate
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND association_id = :association_id::uuid AND binding_hash = :binding_hash::bytea;
