DELETE FROM content.account_erasure_statement
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND due_at = :due_at::timestamptz AND decision_id = :decision_id::uuid;
