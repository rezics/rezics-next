-- unbound: one Global exact package primary key.
SELECT id, kind, publisher, title, summary, subject_id::text AS subject_id
FROM launcher.package
WHERE id = :id::text AND live_count > 0;
