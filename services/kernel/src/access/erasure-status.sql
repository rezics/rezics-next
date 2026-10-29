SELECT statement_timestamp()::text AS "readAt", version, at::text, completed_at::text AS "completedAt",
       (e.completed_at IS NULL AND (e.workflow_until IS NULL OR EXISTS (
         SELECT 1 FROM dbos.workflow_status w
         WHERE w.queue_name = :queue::text AND w.status IN ('ENQUEUED', 'PENDING')
           AND w.created_at <= e.workflow_until))) AS "effectsFrontier",
       EXISTS (SELECT 1 FROM access.erasure_late_item l WHERE l.route = e.route AND l.account_id = e.account_id
               AND l.resolved_at IS NULL) AS "lateItems",
       COALESCE((SELECT jsonb_object_agg(participant, jsonb_build_object('outcome', outcome,
                   'retained', retained, 'resolutions', resolutions))
                 FROM access.erasure_acknowledgement a
                 WHERE a.route = e.route AND a.account_id = e.account_id), '{}'::jsonb) AS outcomes
FROM access.erasure e
WHERE route = :route::integer AND account_id = :account_id::uuid;
