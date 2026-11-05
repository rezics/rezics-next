-- Derived input only: the population home remains authoritative. Equal/older deliveries are no-ops.
INSERT INTO rating.subject_home_prior_input
  (partition_no, population_route, question_id, population_id, generation, epoch, status, m, c, question_identity)
SELECT :partition_no::integer, source.population_route, source.question_id, source.population_id,
       source.generation, source.epoch, source.status, source.m, source.c,
       COALESCE(source.question_identity, CASE WHEN source.question_id = '00000000-0000-7000-8000-000000000001'::uuid
         THEN '[1,"work",0,20,1]' END)
FROM jsonb_to_recordset(:inputs::jsonb) AS source(
  population_route integer, question_id uuid, population_id uuid, generation bigint,
  epoch integer, status text, m numeric, c bigint, question_identity text
)
WHERE true
ON CONFLICT (partition_no, population_route, question_id, population_id) DO UPDATE
SET generation = EXCLUDED.generation, epoch = EXCLUDED.epoch, status = EXCLUDED.status,
    m = EXCLUDED.m, c = EXCLUDED.c, question_identity = EXCLUDED.question_identity
WHERE rating.subject_home_prior_input.generation < EXCLUDED.generation
RETURNING 1;
