SELECT binding_hash AS "bindingHash", assessment, false_positive AS "falsePositive",
       revision::text AS revision, source_epoch AS "sourceEpoch",
       source_position::text AS "sourcePosition", eligibility_generation::text AS "eligibilityGeneration",
       eligible
FROM rating.classification_contribution
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND association_id = :association_id::uuid
  AND actor_route = :actor_route::integer AND actor_id = :actor_id::uuid
FOR UPDATE;
