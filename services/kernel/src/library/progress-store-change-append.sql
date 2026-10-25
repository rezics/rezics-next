INSERT INTO library.progress_change
  (route, session_id, change_no, intent, recorded_at, transaction_id)
VALUES
  (:route, :session_id, :change_no, :intent::jsonb, :time::timestamptz, :transaction_id)
RETURNING route, session_id AS "sessionId", change_no AS "changeNo", intent, recorded_at::text AS "recordedAt",
          transaction_id AS "transactionId";
