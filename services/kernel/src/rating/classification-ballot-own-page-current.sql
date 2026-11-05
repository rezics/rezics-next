SELECT b.subject_id AS "subjectId", b.association_id AS "associationId",
       b.binding_hash AS "bindingHash", b.assessment, b.false_positive AS "falsePositive",
       b.revision::text AS revision, b.eligibility_generation::text AS "eligibilityGeneration"
FROM jsonb_to_recordset(:keys::jsonb) AS k(subject_id uuid, association_id uuid)
JOIN rating.classification_ballot b
  ON b.route = :route::integer AND b.actor_id = :actor_id::uuid
 AND b.subject_id = k.subject_id AND b.association_id = k.association_id
WHERE b.eligible AND b.assessment IS NOT NULL AND b.eligibility_generation = :generation::bigint;
