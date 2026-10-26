SELECT to_jsonb(r) AS data FROM access.operator_opening_receipt r
WHERE route = :route AND operator_account_id = :operator_id AND receipt_id = :receipt_id
  AND consumed_at IS NOT NULL AND expires_at > :at::timestamptz;
