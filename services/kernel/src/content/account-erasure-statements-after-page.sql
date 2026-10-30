SELECT due_at::text, owner_route, decision_id::text
FROM content.account_erasure_statement
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND due_at <= :as_of::timestamptz
  AND (due_at, decision_id) > (:after_due_at::timestamptz, :after_decision_id::uuid)
ORDER BY due_at, decision_id
LIMIT 50;
