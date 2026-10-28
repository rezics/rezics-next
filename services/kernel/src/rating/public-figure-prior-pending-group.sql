WITH input AS (
  SELECT :partition_no::nullable(integer) AS partition_no
)
SELECT figure.question_id::text AS "questionId", figure.population_id::text AS "populationId"
FROM rating.public_figure AS figure CROSS JOIN input
WHERE figure.pending_prior_generation IS NOT NULL
  AND (input.partition_no IS NULL OR figure.partition_no = input.partition_no)
GROUP BY figure.question_id, figure.population_id
ORDER BY figure.question_id, figure.population_id
LIMIT 1;
