WITH input AS (
  SELECT :partition_no::integer AS partition_no, :limit::integer AS page_limit,
         :subject_ids::nullable(uuid[]) AS subject_ids,
         :question_id::nullable(uuid) AS question_id,
         :population_id::nullable(uuid) AS population_id
)
SELECT figure.question_id::text AS "questionId", figure.population_id::text AS "populationId",
       figure.subject_id::text AS "subjectId"
FROM rating.public_figure AS figure CROSS JOIN input
WHERE figure.partition_no = input.partition_no AND figure.pending_position IS NOT NULL
  AND (input.subject_ids IS NULL OR figure.subject_id = ANY(input.subject_ids))
  AND (input.question_id IS NULL OR figure.question_id = input.question_id)
  AND (input.population_id IS NULL OR figure.population_id = input.population_id)
ORDER BY figure.route, figure.question_id, figure.population_id, figure.subject_id
LIMIT (SELECT page_limit FROM input);
