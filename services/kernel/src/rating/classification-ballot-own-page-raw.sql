WITH selection AS (SELECT :selected_subject::uuid AS subject_id)
SELECT ballot.subject_id AS "subjectId", ballot.association_id AS "associationId",
       ballot.binding_hash AS "bindingHash", ballot.assessment,
       ballot.false_positive AS "falsePositive", ballot.revision::text AS revision,
       ballot.eligibility_generation::text AS "eligibilityGeneration"
FROM rating.classification_ballot AS ballot CROSS JOIN selection
WHERE ballot.route = :route::integer AND ballot.actor_id = :actor_id::uuid
  AND ballot.eligible AND ballot.assessment IS NOT NULL AND ballot.eligibility_generation = :generation::bigint
  AND (ballot.subject_id, ballot.association_id) > (:after_subject::uuid, :after_association::uuid)
  AND (
    selection.subject_id IS NULL
    OR (ballot.subject_id, ballot.association_id) <> (selection.subject_id, :selected_association::uuid)
  )
ORDER BY ballot.subject_id, ballot.association_id
LIMIT 21;
