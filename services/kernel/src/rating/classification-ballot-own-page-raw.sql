WITH selection AS (SELECT :selected_subject::uuid AS selected_subject)
SELECT subject_id AS "subjectId", association_id AS "associationId",
       binding_hash AS "bindingHash", assessment, false_positive AS "falsePositive",
       revision::text AS revision, eligibility_generation::text AS "eligibilityGeneration"
FROM rating.classification_ballot
CROSS JOIN selection
WHERE route = :route::integer AND actor_id = :actor_id::uuid
  AND eligible AND assessment IS NOT NULL AND eligibility_generation = :generation::bigint
  AND (subject_id, association_id) > (:after_subject::uuid, :after_association::uuid)
  AND (selected_subject IS NULL OR (subject_id, association_id) <> (selected_subject, :selected_association::uuid))
ORDER BY subject_id, association_id
LIMIT 21;
