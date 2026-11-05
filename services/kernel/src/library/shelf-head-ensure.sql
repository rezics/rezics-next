INSERT INTO library.progress_head AS head (route, account_id, subject_id)
VALUES (:route, :account_id, :subject_id)
ON CONFLICT (route, account_id, subject_id) DO UPDATE
SET last_changed_at = head.last_changed_at
RETURNING last_changed_at::text AS "lastChangedAt", last_completed_at::text AS "lastCompletedAt";
