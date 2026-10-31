-- Derived input only: the population home remains authoritative. Equal/older deliveries are no-ops.
INSERT INTO rating.subject_home_prior_input
  (partition_no, population_route, question_id, population_id, generation, epoch, status, m, c)
SELECT :partition_no::integer, source.population_route, source.question_id, source.population_id,
       source.generation, source.epoch, source.status, source.m, source.c
FROM jsonb_to_recordset(:inputs::jsonb) AS source(
  population_route integer, question_id uuid, population_id uuid, generation bigint,
  epoch integer, status text, m numeric, c bigint
)
WHERE true
ON CONFLICT (partition_no, population_route, question_id, population_id) DO UPDATE
SET generation = EXCLUDED.generation, epoch = EXCLUDED.epoch, status = EXCLUDED.status,
    m = EXCLUDED.m, c = EXCLUDED.c
WHERE rating.subject_home_prior_input.generation < EXCLUDED.generation
RETURNING 1;
