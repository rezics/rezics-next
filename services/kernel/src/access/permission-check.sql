WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id, :action::text AS action,
         NULLIF(:actor_id::text, '')::uuid AS actor_id, NULLIF(:principal_id::text, '')::uuid AS principal_id,
         :anonymous::boolean AS anonymous, :roles::jsonb AS roles,
         :evidence_valid::tstzrange AS evidence_valid, :deadline::timestamptz AS deadline
), grants AS NOT MATERIALIZED (
  SELECT g.subject_kind, g.subject_id, g.subject_role, g.valid FROM access.resource_grant g CROSS JOIN input i
  WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.action = i.action
  UNION ALL
  SELECT g.subject_kind, g.subject_id, g.subject_role, g.valid FROM access.resource_role_grant g CROSS JOIN input i
  WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.grant_role = ANY(:grant_roles::nullable(text[]))
), authority AS (
  -- Commands bind their opaque attempt time. Unbound read checks retain their
  -- native transaction-time semantics.
  SELECT COALESCE(NULLIF(:at::nullable(text), '')::timestamptz, transaction_timestamp()) AS at,
         clock_timestamp() AS observed_at
), roles AS (
  SELECT r.account_id, r.organization_id, r.role, r.valid
  FROM input i, jsonb_to_recordset(i.roles)
    AS r(account_id uuid, organization_id uuid, role text, valid tstzrange)
)
SELECT (
  t.at < i.deadline AND t.observed_at < i.deadline AND i.evidence_valid @> t.at
  AND (i.anonymous OR (
    EXISTS (
      SELECT 1 FROM grants g
      WHERE g.valid @> t.at
        AND (g.subject_kind = 'active_accounts' OR (g.subject_role = '' AND g.subject_id = i.actor_id) OR EXISTS (
          SELECT 1 FROM roles r WHERE r.account_id = i.actor_id AND r.organization_id = g.subject_id
            AND r.role <> '' AND r.role = g.subject_role AND r.valid @> t.at
        ))
    )
    AND (i.principal_id IS NULL OR EXISTS (
      SELECT 1 FROM grants g
      WHERE g.valid @> t.at
        AND (g.subject_kind = 'active_accounts' OR (g.subject_role = '' AND g.subject_id = i.principal_id) OR EXISTS (
          SELECT 1 FROM roles r WHERE r.account_id = i.principal_id AND r.organization_id = g.subject_id
            AND r.role <> '' AND r.role = g.subject_role AND r.valid @> t.at
        ))
    ))
  ))
  -- A newly introduced organization denial requires new separately anchored
  -- evidence. Its absence cannot fall back to an otherwise usable direct grant.
  AND NOT EXISTS (
    SELECT 1 FROM access.resource_denial d
    WHERE d.route = i.route AND d.resource_id = i.resource_id AND d.action = i.action
      AND d.subject_role <> '' AND d.valid @> t.at AND NOT i.anonymous
      AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id = d.subject_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM access.resource_denial d
    WHERE d.route = i.route AND d.resource_id = i.resource_id AND d.action = i.action AND d.valid @> t.at
      AND (i.anonymous OR (d.subject_role = '' AND d.subject_id IN (i.actor_id, i.principal_id))
        OR EXISTS (
          SELECT 1 FROM roles r WHERE r.account_id IN (i.actor_id, i.principal_id)
            AND r.organization_id = d.subject_id AND r.role <> '' AND r.role = d.subject_role AND r.valid @> t.at
        ))
  )
) AS allowed
FROM input i CROSS JOIN authority t;
