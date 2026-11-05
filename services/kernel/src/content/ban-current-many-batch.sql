WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.realm_id, accounts.account_id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, realm_id uuid, account_ids uuid[])
  CROSS JOIN LATERAL unnest(k.account_ids) AS accounts(account_id)
)
SELECT DISTINCT route, realm_id, account_id
FROM input
JOIN community.realm_ban USING (route, realm_id, account_id)
WHERE upper_inf(valid) AND valid @> :at::timestamptz;
