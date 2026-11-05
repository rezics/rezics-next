WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id), page AS MATERIALIZED (SELECT subject_id FROM library.entry WHERE route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) AND subject_id>:after::uuid ORDER BY subject_id LIMIT 100)
 UPDATE library.entry AS e SET activity_at=GREATEST(e.activity_at,e.created_at,e.updated_at,h.last_changed_at),
 finished_at=GREATEST(e.finished_at,h.last_completed_at,CASE WHEN e.state='completed' THEN e.updated_at END)
 FROM page LEFT JOIN library.progress_head h ON h.route=(SELECT arg.route FROM input arg) AND h.account_id=(SELECT arg.account_id FROM input arg) AND h.subject_id=page.subject_id
 WHERE e.route=(SELECT arg.route FROM input arg) AND e.account_id=(SELECT arg.account_id FROM input arg) AND e.subject_id=page.subject_id RETURNING e.subject_id AS "subjectId",e.incarnation_id AS "incarnationId",e.revision,e.transaction_id AS "transactionId";
