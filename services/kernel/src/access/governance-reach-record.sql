INSERT INTO access.governance_reach
  (route, transaction_id, action, resource_id, actor_account_id)
VALUES
  (:route::integer, :transaction_id::uuid, :action::text, :resource_id::uuid, :actor_account_id::uuid)
ON CONFLICT (route, transaction_id, action, resource_id) DO NOTHING;
