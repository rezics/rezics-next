-- Eligibility needs no type, labels, redirect history, facts or private bodies.
-- The full primary key bounds both the present and absent probe to one tuple.
SELECT visibility, security_revision::text AS security_revision
FROM semantic.subject
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
