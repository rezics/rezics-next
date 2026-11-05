SELECT route, question_id::text AS "questionId", population_id::text AS "populationId",
       generation::text AS generation, after_subject_id::text AS "afterSubjectId"
FROM rating.population_prior_republish
ORDER BY route, question_id, population_id
LIMIT 1;
