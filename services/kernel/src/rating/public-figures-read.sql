WITH requested AS MATERIALIZED (
  SELECT DISTINCT subject_id,
         get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11) AS route
  FROM unnest(:subject_ids::uuid[]) AS subject_id
)
SELECT figure.question_id::text AS "questionId", figure.population_id::text AS "populationId",
       figure.subject_id::text AS "subjectId", figure.count::text AS count,
       figure.mean::text AS mean, figure.score::text AS score, figure.m::text AS m,
       figure.c::text AS "C", figure.prior_epoch AS "priorEpoch", figure.revision::text AS revision,
       figure.as_of::text AS "asOf", figure.position::text AS position
FROM requested
JOIN rating.public_figure AS figure
  ON figure.route = requested.route
 AND figure.question_id = :question_id::uuid
 AND figure.population_id = :population_id::uuid
 AND figure.subject_id = requested.subject_id
WHERE figure.partition_no = :partition_no::integer
  AND figure.revision > 0
ORDER BY figure.subject_id;
