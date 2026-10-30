-- Event subjects are locators only: candidate IDs cannot become population subjects.
SELECT subject_id::text AS id FROM semantic.subject WHERE route = $1 AND subject_id = $2::uuid;
