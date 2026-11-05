-- Serialize provider heads even when no statistic/head exists yet. This is one subject-local row.
SELECT subject_id::text AS "subjectId"
FROM semantic.subject
WHERE route = :route::integer AND subject_id = :subject_id::uuid
FOR UPDATE;
