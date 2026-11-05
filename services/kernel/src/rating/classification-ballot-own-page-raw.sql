WITH page_args AS MATERIALIZED (
  SELECT :route::integer AS arg_route,
         :actor_id::uuid AS arg_actor_id,
         :generation::bigint AS arg_generation,
         :after_subject::uuid AS arg_after_subject,
         :after_association::uuid AS arg_after_association,
         :selected_subject::nullable(uuid) AS arg_selected_subject,
         :selected_association::nullable(uuid) AS arg_selected_association
)
SELECT ballot.subject_id AS "subjectId", ballot.association_id AS "associationId",
       ballot.binding_hash AS "bindingHash", ballot.assessment,
       ballot.false_positive AS "falsePositive", ballot.revision::text AS revision,
       ballot.eligibility_generation::text AS "eligibilityGeneration"
FROM rating.classification_ballot AS ballot
CROSS JOIN page_args AS args
WHERE ballot.route = args.arg_route AND ballot.actor_id = args.arg_actor_id
  AND ballot.eligible AND ballot.assessment IS NOT NULL AND ballot.eligibility_generation = args.arg_generation
  AND (ballot.subject_id, ballot.association_id) > (args.arg_after_subject, args.arg_after_association)
  AND (args.arg_selected_subject IS NULL OR
       (ballot.subject_id, ballot.association_id) <> (args.arg_selected_subject, args.arg_selected_association))
ORDER BY ballot.subject_id, ballot.association_id
LIMIT 21;
