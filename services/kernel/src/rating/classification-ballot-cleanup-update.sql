WITH input AS (SELECT :generation::bigint AS generation)
UPDATE rating.classification_ballot AS ballot
SET eligible = :eligible::boolean,
    eligibility_generation = input.generation,
    revision = ballot.revision + 1
FROM input
WHERE ballot.route = :route::integer AND ballot.actor_id = :actor_id::uuid
  AND ballot.assessment IS NOT NULL AND ballot.eligibility_generation < input.generation
  AND (ballot.subject_id, ballot.association_id) IN (
    SELECT subject_id, association_id
    FROM unnest(:subject_ids::uuid[], :association_ids::uuid[]) AS page(subject_id, association_id)
  )
RETURNING ballot.subject_id::text AS "subjectId", ballot.association_id::text AS "associationId",
          ballot.binding_hash AS "bindingHash", ballot.assessment,
          ballot.false_positive AS "falsePositive", ballot.revision::text AS revision;
