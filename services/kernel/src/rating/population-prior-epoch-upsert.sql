INSERT INTO rating.population_prior_epoch
  (route, question_id, population_id, epoch, generation, start_count, m, c, question_identity)
VALUES (:route::integer, :question_id::uuid, :population_id::uuid, :epoch::integer,
        :generation::bigint, :start_count::nullable(bigint), :m::nullable(numeric), :c::nullable(bigint), :question_identity::text)
ON CONFLICT (route, question_id, population_id) DO UPDATE
SET epoch = EXCLUDED.epoch,
    generation = EXCLUDED.generation,
    start_count = EXCLUDED.start_count,
    m = EXCLUDED.m,
    c = EXCLUDED.c,
    question_identity = EXCLUDED.question_identity
RETURNING 1;
