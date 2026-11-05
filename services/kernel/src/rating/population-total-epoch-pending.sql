SELECT total.question_id::text AS "questionId", total.population_id::text AS "populationId"
FROM rating.population_total_component AS total
WHERE total.needs_epoch_check
GROUP BY total.question_id, total.population_id
ORDER BY total.question_id, total.population_id
LIMIT :limit::integer;
