INSERT INTO content.report_outcome_work (route, decision_id, after_at, after_id, done)
VALUES (:route::integer, :decision_id::uuid, :after_at::timestamptz, :after_id::uuid, :done::boolean)
ON CONFLICT (route, decision_id) DO UPDATE
SET after_at = EXCLUDED.after_at, after_id = EXCLUDED.after_id, done = EXCLUDED.done
WHERE NOT report_outcome_work.done
  AND (EXCLUDED.after_at, EXCLUDED.after_id) <= (report_outcome_work.after_at, report_outcome_work.after_id);
