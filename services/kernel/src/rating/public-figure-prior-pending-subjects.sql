WITH input AS (
  SELECT :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :partition_no::nullable(integer) AS partition_no, :limit::integer AS page_limit
)
SELECT figure.partition_no AS partition, figure.subject_id::text AS "subjectId"
FROM rating.public_figure AS figure
  CROSS JOIN input
WHERE figure.question_id = input.question_id
  AND figure.population_id = input.population_id
  AND (input.partition_no IS NULL OR figure.partition_no = input.partition_no)
  AND figure.pending_prior_generation IS NOT NULL
ORDER BY figure.partition_no, figure.route, figure.subject_id
LIMIT (SELECT page_limit FROM input);
