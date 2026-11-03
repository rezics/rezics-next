WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id), page AS MATERIALIZED (SELECT session_id,subject_id,last_changed_at,completed_at FROM library.progress_session
 WHERE state <> 'retired' AND route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) AND session_id>:after::uuid ORDER BY session_id LIMIT 100), saved AS (
 INSERT INTO library.shelf_maintenance_head(route,account_id,run_id,subject_id,last_changed_at,last_completed_at)
 SELECT (SELECT arg.route FROM input arg),(SELECT arg.account_id FROM input arg),:run_id::uuid,subject_id,max(last_changed_at),max(completed_at) FROM page GROUP BY subject_id
 ON CONFLICT(route,account_id,run_id,subject_id) DO UPDATE SET
 last_changed_at=GREATEST(shelf_maintenance_head.last_changed_at,EXCLUDED.last_changed_at),
 last_completed_at=GREATEST(shelf_maintenance_head.last_completed_at,EXCLUDED.last_completed_at) RETURNING subject_id)
 SELECT session_id AS id FROM page ORDER BY session_id;
