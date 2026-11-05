WITH input AS (SELECT :time::timestamptz AS time)
INSERT INTO library.progress_head AS head (route, account_id, subject_id, last_changed_at, last_completed_at)
SELECT :route, :account_id, :subject_id, input.time,
       CASE WHEN :completed::boolean THEN input.time ELSE NULL END
FROM input
WHERE true
ON CONFLICT (route, account_id, subject_id) DO UPDATE
SET last_changed_at = GREATEST(head.last_changed_at, EXCLUDED.last_changed_at),
    last_completed_at = GREATEST(head.last_completed_at, EXCLUDED.last_completed_at);
