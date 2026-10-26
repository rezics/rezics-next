-- unbound: Global partition only: exact identity/action temporal seeks for the mounted gate catalogue, a deployment constant.
-- One identity probe of the viewer's gate actions on the Global Context.
-- Scalar counts stay on the temporal primary key for the actor and principal,
-- so other accounts' grants are not scanned. gate:any and gate:<group> stay exact.
WITH authority AS MATERIALIZED (
  SELECT :at::timestamptz AS at
), input AS MATERIALIZED (
  SELECT NULLIF(:actor_id::text, '')::uuid AS actor_id,
         NULLIF(:principal_id::text, '')::uuid AS principal_id,
         :resource_id::uuid AS resource_id
), wanted AS MATERIALIZED (
  SELECT w.action,
         COALESCE(ARRAY(SELECT jsonb_array_elements_text(w.grant_roles)), ARRAY[]::text[]) AS grant_roles
  FROM jsonb_to_recordset(:actions::jsonb) AS w(action text, grant_roles jsonb)
)
SELECT wanted.action
FROM wanted
CROSS JOIN input
CROSS JOIN authority
WHERE input.actor_id IS NOT NULL
  AND (
    (SELECT count(*) FROM access.resource_grant g
      WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.action = wanted.action
        AND g.subject_kind = 'identity' AND g.subject_id = input.actor_id AND g.subject_role = ''
        AND g.valid @> authority.at) > 0
    OR (SELECT count(*) FROM unnest(wanted.grant_roles) AS role(grant_role)
      WHERE (SELECT count(*) FROM access.resource_role_grant g
        WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.grant_role = role.grant_role
          AND g.subject_kind = 'identity' AND g.subject_id = input.actor_id AND g.subject_role = ''
          AND g.valid @> authority.at) > 0) > 0
    OR (SELECT count(*) FROM access.resource_grant g
      WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.action = wanted.action
        AND g.subject_kind = 'active_accounts'
        AND g.subject_id = '00000000-0000-0000-0000-000000000000'::uuid
        AND g.subject_role = ''
        AND g.valid @> authority.at) > 0
    OR (SELECT count(*) FROM unnest(wanted.grant_roles) AS role(grant_role)
      WHERE (SELECT count(*) FROM access.resource_role_grant g
        WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.grant_role = role.grant_role
          AND g.subject_kind = 'active_accounts'
          AND g.subject_id = '00000000-0000-0000-0000-000000000000'::uuid
          AND g.subject_role = ''
          AND g.valid @> authority.at) > 0) > 0
  )
  AND (SELECT count(*) FROM access.resource_denial d
    WHERE d.route = 0 AND d.resource_id = input.resource_id AND d.action = wanted.action
      AND d.subject_id = input.actor_id AND d.subject_role = ''
      AND d.valid @> authority.at) = 0
  AND (
    input.principal_id IS NULL
    OR (
      (
        (SELECT count(*) FROM access.resource_grant g
          WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.action = wanted.action
            AND g.subject_kind = 'identity' AND g.subject_id = input.principal_id AND g.subject_role = ''
            AND g.valid @> authority.at) > 0
        OR (SELECT count(*) FROM unnest(wanted.grant_roles) AS role(grant_role)
          WHERE (SELECT count(*) FROM access.resource_role_grant g
            WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.grant_role = role.grant_role
              AND g.subject_kind = 'identity' AND g.subject_id = input.principal_id AND g.subject_role = ''
              AND g.valid @> authority.at) > 0) > 0
        OR (SELECT count(*) FROM access.resource_grant g
          WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.action = wanted.action
            AND g.subject_kind = 'active_accounts'
            AND g.subject_id = '00000000-0000-0000-0000-000000000000'::uuid
            AND g.subject_role = ''
            AND g.valid @> authority.at) > 0
        OR (SELECT count(*) FROM unnest(wanted.grant_roles) AS role(grant_role)
          WHERE (SELECT count(*) FROM access.resource_role_grant g
            WHERE g.route = 0 AND g.resource_id = input.resource_id AND g.grant_role = role.grant_role
              AND g.subject_kind = 'active_accounts'
              AND g.subject_id = '00000000-0000-0000-0000-000000000000'::uuid
              AND g.subject_role = ''
              AND g.valid @> authority.at) > 0) > 0
      )
      AND (SELECT count(*) FROM access.resource_denial d
        WHERE d.route = 0 AND d.resource_id = input.resource_id AND d.action = wanted.action
          AND d.subject_id = input.principal_id AND d.subject_role = ''
          AND d.valid @> authority.at) = 0
    )
  );
