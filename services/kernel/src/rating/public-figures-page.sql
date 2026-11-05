SELECT figure.question_id::text AS "questionId", figure.population_id::text AS "populationId",
       figure.subject_id::text AS "subjectId", figure.count::text AS count,
       figure.mean::text AS mean, figure.score::text AS score, figure.m::text AS m,
       figure.c::text AS "C", figure.prior_epoch AS "priorEpoch", figure.revision::text AS revision,
       figure.as_of::text AS "asOf", figure.position::text AS position
FROM rating.public_figure AS figure
WHERE figure.partition_no = :partition_no::integer
  AND figure.question_id = :question_id::uuid
  AND figure.population_id = :population_id::uuid
  AND figure.revision > 0
  AND figure.subject_id > :after::uuid
ORDER BY figure.subject_id
LIMIT :limit::integer;
