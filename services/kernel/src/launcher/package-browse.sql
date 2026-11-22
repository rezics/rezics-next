-- unbound: one Global catalogue seek in package_kind_visible.
SELECT id, kind, publisher, title, summary, subject_id::text AS subject_id
FROM launcher.package
WHERE kind = :kind::text AND live_count > 0 AND id > :after_id::text
ORDER BY id
LIMIT :limit::integer;
