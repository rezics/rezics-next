WITH input AS (
  SELECT :partition_no::integer AS partition_no, :question_id::uuid AS question_id,
         :population_id::uuid AS population_id, :after::uuid AS after_subject_id, :limit::integer AS page_limit
)
SELECT figure.question_id::text AS "questionId", figure.population_id::text AS "populationId",
       figure.subject_id::text AS "subjectId", figure.count::text AS count,
       figure.mean::text AS mean, figure.score::text AS score, figure.m::text AS m,
       figure.c::text AS "C", figure.prior_epoch AS "priorEpoch", figure.revision::text AS revision,
       figure.as_of::text AS "asOf", figure.position::text AS position
FROM rating.public_figure AS figure
JOIN input ON figure.partition_no = input.partition_no
  AND figure.question_id = input.question_id
  AND figure.population_id = input.population_id
  AND figure.revision > 0
  AND figure.subject_id > input.after_subject_id
ORDER BY figure.subject_id
LIMIT (SELECT page_limit FROM input);
