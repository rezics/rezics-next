WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id), page AS MATERIALIZED (SELECT session_id FROM library.progress_session WHERE route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) AND session_id>:after::uuid ORDER BY session_id LIMIT 100)
 UPDATE library.progress_session s SET last_changed_at=GREATEST(s.last_changed_at,s.started_at,s.completed_at,scratch.last_changed_at)
 FROM page LEFT JOIN library.shelf_maintenance_session scratch ON scratch.route=(SELECT arg.route FROM input arg) AND scratch.account_id=(SELECT arg.account_id FROM input arg)
 AND scratch.run_id=:run_id::uuid AND scratch.session_id=page.session_id
 WHERE s.route=(SELECT arg.route FROM input arg) AND s.account_id=(SELECT arg.account_id FROM input arg) AND s.session_id=page.session_id RETURNING s.session_id AS id;
