SELECT CASE WHEN start_count IS NULL THEN NULL ELSE epoch END AS "priorEpoch"
FROM rating.population_prior_epoch
WHERE route = :route::integer
  AND question_id = :question_id::uuid
  AND population_id = :population_id::uuid;
