WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
         :actions::text[] AS actions, :transaction_id::uuid AS transaction_id, :at::timestamptz AS at
), installed AS (
  INSERT INTO access.standing_parent_installation (route, resource_id, actions, transaction_id)
  SELECT route, resource_id, actions, transaction_id FROM input
  RETURNING route, resource_id
)
INSERT INTO access.resource_grant
  (route, resource_id, subject_kind, subject_id, action, valid, transaction_id)
SELECT i.route, i.resource_id, 'active_accounts', '00000000-0000-0000-0000-000000000000', a.action,
       tstzrange(i.at, NULL, '[)'), i.transaction_id
FROM input i JOIN installed n ON n.route = i.route AND n.resource_id = i.resource_id
CROSS JOIN unnest(i.actions) AS a(action)
RETURNING action;
