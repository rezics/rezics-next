INSERT INTO semantic.retraction (route, subject_id, candidate_id, revision, "references")
VALUES (:route::integer, :subject_id::uuid, :candidate_id::uuid, :revision::integer, :references::jsonb);
