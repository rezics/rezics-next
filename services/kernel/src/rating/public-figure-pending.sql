INSERT INTO rating.public_figure (route, question_id, population_id, subject_id, pending_position)
VALUES (:route::integer, :question_id::uuid, :population_id::uuid, :subject_id::uuid, :position::bigint)
ON CONFLICT (route, question_id, population_id, subject_id) DO UPDATE
SET pending_position = EXCLUDED.pending_position
RETURNING 1;
