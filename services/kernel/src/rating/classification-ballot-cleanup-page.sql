SELECT subject_id::text AS "subjectId", association_id::text AS "associationId",
       binding_hash AS "bindingHash", assessment,
       false_positive AS "falsePositive", revision::text AS revision
FROM rating.classification_ballot
WHERE route = :route::integer AND actor_id = :actor_id::uuid
  AND assessment IS NOT NULL AND eligibility_generation < :generation::bigint
ORDER BY subject_id, association_id
LIMIT 51;
