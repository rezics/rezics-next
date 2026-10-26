INSERT INTO access.governance_reach
  (route, transaction_id, action, resource_id, actor_account_id)
SELECT :route::integer, :transaction_id::uuid, :action::text, id, :actor_account_id::uuid
FROM unnest(:resource_ids::uuid[]) id
ON CONFLICT (route, transaction_id, action, resource_id) DO NOTHING;
