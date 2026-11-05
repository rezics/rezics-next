SELECT pending_position IS NOT NULL AS pending
FROM rating.public_figure
WHERE route = :route::integer
  AND question_id = :question_id::uuid
  AND population_id = :population_id::uuid
  AND subject_id = :subject_id::uuid;
