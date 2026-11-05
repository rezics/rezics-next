SELECT component.target_id::text AS "subjectId", min(component.route)::integer AS route
FROM rating.aggregate_component AS component
WHERE component.question_id = :question_id::uuid
  AND component.population_id = :population_id::uuid
  AND component.target_id > :after_subject_id::uuid
  AND component.count > 0
GROUP BY component.target_id
ORDER BY component.target_id
LIMIT :limit::integer + 1;
