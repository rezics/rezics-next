UPDATE rating.population_prior_republish
SET after_subject_id = :after_subject_id::nullable(uuid)
WHERE route = :route::integer AND question_id = :question_id::uuid AND population_id = :population_id::uuid
  AND generation = :generation::bigint
  AND after_subject_id IS NOT DISTINCT FROM :expected_after_subject_id::nullable(uuid)
RETURNING 1;
