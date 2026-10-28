INSERT INTO rating.population_prior_republish
  (route, question_id, population_id, generation, after_subject_id)
VALUES (:route::integer, :question_id::uuid, :population_id::uuid, :generation::bigint, NULL)
ON CONFLICT (route, question_id, population_id) DO UPDATE
SET generation = EXCLUDED.generation,
    after_subject_id = NULL
RETURNING 1;
