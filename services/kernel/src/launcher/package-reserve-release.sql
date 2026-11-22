-- unbound: one Global exact package insert or increment. A metadata mismatch returns no row.
INSERT INTO launcher.package AS p (id, kind, publisher, title, title_key, summary, subject_id, live_count)
VALUES (:id, :kind, :publisher, :title, :title_key, :summary, :subject_id::nullable(uuid), 1)
ON CONFLICT (id) DO UPDATE SET live_count = p.live_count + 1
WHERE (p.kind, p.publisher, p.title, p.summary, p.subject_id) IS NOT DISTINCT FROM
      (EXCLUDED.kind, EXCLUDED.publisher, EXCLUDED.title, EXCLUDED.summary, EXCLUDED.subject_id)
RETURNING id;
