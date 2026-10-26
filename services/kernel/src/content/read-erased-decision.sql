-- Ordinary permission formula crossed with the same formula at floor false and empty grant roles.
WITH params AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id, :action::text AS action,
         NULLIF(:actor_id::text, '')::uuid AS actor_id, NULLIF(:principal_id::text, '')::uuid AS principal_id,
         :anonymous::boolean AS anonymous, COALESCE(:floor::nullable(boolean), false) AS floor,
         :deadline::timestamptz AS deadline, :roles::jsonb AS roles,
         NULLIF(:at::nullable(text), '')::timestamptz AS at,
         :grant_roles::nullable(text[]) AS grant_roles, :evidence_valid::tstzrange AS evidence_valid
),
ordinary_input AS NOT MATERIALIZED (
  SELECT params.route AS route, params.resource_id AS resource_id, params.action AS action,
         params.actor_id AS actor_id, params.principal_id AS principal_id, params.anonymous AS anonymous, params.floor AS floor, params.deadline AS deadline
  FROM params
), ordinary_keys AS MATERIALIZED (
  SELECT r.account_id, r.organization_id AS subject_id, 'identity'::text AS subject_kind,
         r.role AS subject_role, r.member, r.valid
  FROM jsonb_to_recordset((SELECT roles FROM params))
    AS r(account_id uuid, organization_id uuid, role text, member boolean, valid tstzrange)
  UNION ALL
  SELECT id, id, 'identity', '', true, '(,)'::tstzrange
  FROM ordinary_input i CROSS JOIN LATERAL (VALUES (i.actor_id), (i.principal_id)) a(id) WHERE id IS NOT NULL
  UNION ALL
  SELECT id, '00000000-0000-0000-0000-000000000000'::uuid, 'active_accounts', '', true, '(,)'::tstzrange
  FROM ordinary_input i CROSS JOIN LATERAL (VALUES (i.actor_id), (i.principal_id)) a(id) WHERE id IS NOT NULL
), ordinary_authority AS MATERIALIZED (
  SELECT COALESCE((SELECT at FROM params), transaction_timestamp()) AS at,
         clock_timestamp() AS observed_at
), ordinary_probes AS MATERIALIZED (
  SELECT k.*,
    ((SELECT count(*) FROM access.resource_grant g CROSS JOIN ordinary_input i
      WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.action = i.action
        AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
        AND g.valid @> (SELECT at FROM ordinary_authority)
    ) > 0 OR (SELECT count(*) FROM unnest((SELECT grant_roles FROM params)) role(grant_role)
      WHERE (SELECT count(*) FROM access.resource_role_grant g CROSS JOIN ordinary_input i
        WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.grant_role = role.grant_role
          AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid @> (SELECT at FROM ordinary_authority)
      ) > 0
    ) > 0) AS granted,
    (k.subject_kind = 'identity' AND (SELECT count(*) FROM access.resource_denial d CROSS JOIN ordinary_input i
      WHERE d.route = i.route AND d.resource_id = i.resource_id AND d.action = i.action
        AND d.subject_id = k.subject_id AND d.subject_role = k.subject_role AND d.valid @> (SELECT at FROM ordinary_authority)
    ) > 0) AS denied
  FROM ordinary_keys k
),
explicit_input AS NOT MATERIALIZED (
  SELECT params.route AS route, params.resource_id AS resource_id, params.action AS action,
         params.actor_id AS actor_id, params.principal_id AS principal_id, params.anonymous AS anonymous, false::boolean AS floor, params.deadline AS deadline
  FROM params
), explicit_keys AS MATERIALIZED (
  SELECT r.account_id, r.organization_id AS subject_id, 'identity'::text AS subject_kind,
         r.role AS subject_role, r.member, r.valid
  FROM jsonb_to_recordset((SELECT roles FROM params))
    AS r(account_id uuid, organization_id uuid, role text, member boolean, valid tstzrange)
  UNION ALL
  SELECT id, id, 'identity', '', true, '(,)'::tstzrange
  FROM explicit_input i CROSS JOIN LATERAL (VALUES (i.actor_id), (i.principal_id)) a(id) WHERE id IS NOT NULL
  UNION ALL
  SELECT id, '00000000-0000-0000-0000-000000000000'::uuid, 'active_accounts', '', true, '(,)'::tstzrange
  FROM explicit_input i CROSS JOIN LATERAL (VALUES (i.actor_id), (i.principal_id)) a(id) WHERE id IS NOT NULL
), explicit_authority AS MATERIALIZED (
  SELECT COALESCE((SELECT at FROM params), transaction_timestamp()) AS at,
         clock_timestamp() AS observed_at
), explicit_probes AS MATERIALIZED (
  SELECT k.*,
    ((SELECT count(*) FROM access.resource_grant g CROSS JOIN explicit_input i
      WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.action = i.action
        AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
        AND g.valid @> (SELECT at FROM explicit_authority)
    ) > 0 OR (SELECT count(*) FROM unnest('{}'::text[]) role(grant_role)
      WHERE (SELECT count(*) FROM access.resource_role_grant g CROSS JOIN explicit_input i
        WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.grant_role = role.grant_role
          AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid @> (SELECT at FROM explicit_authority)
      ) > 0
    ) > 0) AS granted,
    (k.subject_kind = 'identity' AND (SELECT count(*) FROM access.resource_denial d CROSS JOIN explicit_input i
      WHERE d.route = i.route AND d.resource_id = i.resource_id AND d.action = i.action
        AND d.subject_id = k.subject_id AND d.subject_role = k.subject_role AND d.valid @> (SELECT at FROM explicit_authority)
    ) > 0) AS denied
  FROM explicit_keys k
)
SELECT ordinary.allowed, explicit.allowed AS explicit_read
FROM (
SELECT (
  t.observed_at < i.deadline
  AND (SELECT evidence_valid FROM params) @> t.at
  AND (i.floor OR (NOT i.anonymous AND (
    EXISTS (SELECT 1 FROM ordinary_probes p WHERE p.account_id = i.actor_id AND p.granted AND p.member AND p.valid @> t.at)
    AND (i.principal_id IS NULL OR EXISTS (
      SELECT 1 FROM ordinary_probes p WHERE p.account_id = i.principal_id AND p.granted AND p.member AND p.valid @> t.at
    ))
  )))
  AND NOT EXISTS (
    -- All current group hits require authoritative role/absence evidence.
    -- A new matching denial or grant cannot reuse an unprepared group key.
    SELECT 1 FROM ordinary_probes p
    WHERE (p.denied AND p.member) OR (p.subject_role <> '' AND (p.granted OR p.denied) AND NOT (p.valid @> t.at))
  )
) AS allowed
FROM ordinary_input i CROSS JOIN ordinary_authority t
) ordinary
CROSS JOIN (
SELECT (
  t.observed_at < i.deadline
  AND (SELECT evidence_valid FROM params) @> t.at
  AND (i.floor OR (NOT i.anonymous AND (
    EXISTS (SELECT 1 FROM explicit_probes p WHERE p.account_id = i.actor_id AND p.granted AND p.member AND p.valid @> t.at)
    AND (i.principal_id IS NULL OR EXISTS (
      SELECT 1 FROM explicit_probes p WHERE p.account_id = i.principal_id AND p.granted AND p.member AND p.valid @> t.at
    ))
  )))
  AND NOT EXISTS (
    -- All current group hits require authoritative role/absence evidence.
    -- A new matching denial or grant cannot reuse an unprepared group key.
    SELECT 1 FROM explicit_probes p
    WHERE (p.denied AND p.member) OR (p.subject_role <> '' AND (p.granted OR p.denied) AND NOT (p.valid @> t.at))
  )
) AS allowed
FROM explicit_input i CROSS JOIN explicit_authority t
) explicit;
