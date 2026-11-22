-- unbound: one Global title range seek in package_title_visible.
SELECT id, kind, publisher, title, summary, title_key, subject_id::text AS subject_id
FROM launcher.package
WHERE kind = :kind::text AND live_count > 0
  AND (title_key, id) > (:after_title::text, :after_id::text)
  AND title_key < :upper::text
ORDER BY title_key, id
LIMIT :limit::integer;
