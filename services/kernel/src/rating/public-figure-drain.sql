WITH input AS (
  SELECT :partition_no::integer AS partition_no, :limit::integer AS page_limit
), candidates AS MATERIALIZED (
  SELECT figure.route, figure.question_id, figure.population_id, figure.subject_id,
         figure.pending_position
  FROM rating.public_figure AS figure
  CROSS JOIN input
  WHERE figure.partition_no = input.partition_no
    AND figure.pending_position IS NOT NULL
  ORDER BY figure.route, figure.question_id, figure.population_id, figure.subject_id
  LIMIT (SELECT page_limit FROM input)
  FOR UPDATE OF figure
), totals AS (
  SELECT candidates.route, candidates.question_id, candidates.population_id, candidates.subject_id,
         candidates.pending_position,
         COALESCE(sum(component.count), 0)::bigint AS count,
         CASE
           WHEN COALESCE(sum(component.count), 0) >=
             CASE WHEN question.grain IN ('work', 'release') THEN 5 ELSE 10 END
           THEN round(COALESCE(sum(component.sum), 0)::numeric /
                      (COALESCE(sum(component.count), 0)::numeric * 2), 4)
           ELSE NULL
         END AS mean,
         max(component.applied_at) AS as_of
  FROM candidates
  JOIN rating.question AS question ON question.id = candidates.question_id
  LEFT JOIN rating.aggregate_component AS component
    ON component.route = candidates.route
   AND component.question_id = candidates.question_id
   AND component.population_id = candidates.population_id
   AND component.target_id = candidates.subject_id
  GROUP BY candidates.route, candidates.question_id, candidates.population_id,
           candidates.subject_id, candidates.pending_position, question.grain
), updated AS (
  UPDATE rating.public_figure AS figure
  SET count = totals.count,
      mean = totals.mean,
      score = NULL,
      m = NULL,
      c = NULL,
      prior_epoch = NULL,
      revision = figure.revision + 1,
      as_of = totals.as_of,
      position = totals.pending_position,
      pending_position = NULL
  FROM totals
  WHERE figure.route = totals.route
    AND figure.question_id = totals.question_id
    AND figure.population_id = totals.population_id
    AND figure.subject_id = totals.subject_id
  RETURNING figure.question_id::text AS "questionId", figure.population_id::text AS "populationId",
            figure.subject_id::text AS "subjectId", figure.count::text AS count,
            figure.mean::text AS mean, figure.score::text AS score, figure.m::text AS m,
            figure.c::text AS "C", figure.prior_epoch AS "priorEpoch", figure.revision::text AS revision,
            figure.as_of::text AS "asOf", figure.position::text AS position
)
SELECT * FROM updated
ORDER BY "subjectId", "populationId";
