SELECT subject_id AS "subjectId", association_id AS "associationId",
       binding_hash AS "bindingHash", assessment, false_positive AS "falsePositive",
       revision::text AS revision, eligibility_generation::text AS "eligibilityGeneration"
FROM rating.classification_ballot
WHERE route = :route::integer AND actor_id = :actor_id::uuid
  AND subject_id = :subject_id::uuid AND association_id = :association_id::uuid
  AND eligible AND assessment IS NOT NULL AND eligibility_generation = :generation::bigint;
