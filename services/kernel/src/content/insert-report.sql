INSERT INTO content.report
  (route, report_id, target_kind, target_id, revision_id, reason, evidence,
   reporter_account_id, created_at, recorded_transaction_id)
VALUES (:route::integer, :report_id::uuid, :target_kind::text, :target_id::uuid,
        :revision_id::uuid, :reason::text, :evidence::text, :reporter_account_id::uuid,
        :created_at::timestamptz, :transaction_id::uuid);
