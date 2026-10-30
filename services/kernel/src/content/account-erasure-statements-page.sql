SELECT due_at::text, owner_route, decision_id::text
FROM content.account_erasure_statement
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND due_at <= :as_of::timestamptz
ORDER BY due_at, decision_id
LIMIT 50;
