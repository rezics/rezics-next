WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id), page AS MATERIALIZED (SELECT subject_id,last_changed_at,last_completed_at FROM library.shelf_maintenance_head
 WHERE route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) AND run_id=:run_id::uuid AND subject_id>:after::uuid ORDER BY subject_id LIMIT 100)
 INSERT INTO library.progress_head(route,account_id,subject_id,last_changed_at,last_completed_at)
 SELECT (SELECT arg.route FROM input arg),(SELECT arg.account_id FROM input arg),subject_id,last_changed_at,last_completed_at FROM page ORDER BY subject_id
 ON CONFLICT(route,account_id,subject_id) DO UPDATE SET last_changed_at=GREATEST(progress_head.last_changed_at,EXCLUDED.last_changed_at),
 last_completed_at=GREATEST(progress_head.last_completed_at,EXCLUDED.last_completed_at) RETURNING subject_id AS id;
