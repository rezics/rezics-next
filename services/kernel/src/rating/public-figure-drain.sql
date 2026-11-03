WITH input AS (
  SELECT :partition_no::integer AS partition_no
), keys AS (
  SELECT * FROM unnest(:subject_ids::uuid[], :question_ids::uuid[], :population_ids::uuid[])
    AS key(subject_id, question_id, population_id)
), candidates AS MATERIALIZED (
  SELECT figure.route, figure.partition_no, figure.question_id, figure.population_id, figure.subject_id,
         figure.pending_position, figure.pending_prior_generation, figure.question_identity
  FROM keys
  JOIN rating.public_figure AS figure
    ON figure.route = get_byte(uuid_send(keys.subject_id), 10) * 256 + get_byte(uuid_send(keys.subject_id), 11)
   AND figure.subject_id = keys.subject_id AND figure.question_id = keys.question_id
   AND figure.population_id = keys.population_id
  CROSS JOIN input
  WHERE figure.partition_no = input.partition_no AND figure.pending_position IS NOT NULL
  ORDER BY figure.route, figure.question_id, figure.population_id, figure.subject_id
  FOR UPDATE OF figure
), totals AS (
  SELECT candidates.route, candidates.question_id, candidates.population_id, candidates.subject_id,
         candidates.pending_position, candidates.pending_prior_generation,
         COALESCE(sum(component.count), 0)::bigint AS count,
         COALESCE(sum(component.sum), 0)::bigint AS sum,
         CASE
           WHEN COALESCE(sum(component.count), 0) >=
             CASE WHEN question.grain IN ('work', 'release') THEN 5 ELSE 10 END
           THEN round(COALESCE(sum(component.sum), 0)::numeric /
                      (COALESCE(sum(component.count), 0)::numeric * 2), 4)
           ELSE NULL
         END AS mean,
         CASE WHEN prior.status = 'active' AND prior.question_identity IS NOT DISTINCT FROM candidates.question_identity THEN prior.m END AS prior_m,
         CASE WHEN prior.status = 'active' AND prior.question_identity IS NOT DISTINCT FROM candidates.question_identity THEN prior.c END AS prior_c,
         CASE WHEN prior.status = 'active' AND prior.question_identity IS NOT DISTINCT FROM candidates.question_identity THEN prior.epoch END AS prior_epoch,
         COALESCE(prior.generation, 0) AS prior_generation,
         CASE WHEN COALESCE(sum(component.count), 0) >=
                        CASE WHEN question.grain IN ('work', 'release') THEN 5 ELSE 10 END
                   AND prior.status = 'active' AND prior.question_identity IS NOT DISTINCT FROM candidates.question_identity
              THEN round(((prior.c::numeric * prior.m) + (COALESCE(sum(component.sum), 0)::numeric / 2)) /
                         (prior.c + COALESCE(sum(component.count), 0)), 4)
              ELSE NULL END AS score,
         max(component.applied_at) AS as_of
  FROM candidates
  JOIN rating.question AS question ON question.id = candidates.question_id
  LEFT JOIN rating.aggregate_component AS component
    ON component.route = candidates.route
   AND component.question_id = candidates.question_id
   AND component.population_id = candidates.population_id
   AND component.target_id = candidates.subject_id
  JOIN rating.subject_home_prior_input AS prior
    ON prior.partition_no = candidates.partition_no
   AND prior.population_route = get_byte(uuid_send(candidates.population_id), 10) * 256 +
                     get_byte(uuid_send(candidates.population_id), 11)
   AND prior.question_id = candidates.question_id
   AND prior.population_id = candidates.population_id
  GROUP BY candidates.route, candidates.question_id, candidates.population_id,
           candidates.subject_id, candidates.pending_position, candidates.pending_prior_generation,
           question.grain, prior.status, prior.epoch, prior.generation, prior.m, prior.c,
           candidates.question_identity, prior.question_identity
), updated AS (
  UPDATE rating.public_figure AS figure
  SET count = totals.count,
      mean = totals.mean,
      score = totals.score,
      m = totals.prior_m,
      c = totals.prior_c,
      prior_epoch = totals.prior_epoch,
      revision = figure.revision + 1,
      as_of = totals.as_of,
      position = totals.pending_position,
      pending_position = NULL,
      published_prior_generation = totals.prior_generation,
      pending_prior_generation = NULL
  FROM totals
  WHERE figure.route = totals.route
    AND figure.question_id = totals.question_id
    AND figure.population_id = totals.population_id
    AND figure.subject_id = totals.subject_id
    AND totals.prior_generation >= figure.published_prior_generation
    AND totals.prior_generation >= COALESCE(figure.pending_prior_generation, 0)
  RETURNING figure.question_id::text AS "questionId", figure.population_id::text AS "populationId",
            figure.subject_id::text AS "subjectId", figure.count::text AS count,
            figure.mean::text AS mean, figure.score::text AS score, figure.m::text AS m,
            figure.c::text AS "C", figure.prior_epoch AS "priorEpoch", figure.revision::text AS revision,
            figure.as_of::text AS "asOf", figure.position::text AS position
)
SELECT * FROM updated
ORDER BY "subjectId", "populationId";
