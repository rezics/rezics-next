-- Probe the ordinary resource plus the one fixed Global Context candidate set.
-- Keep each route/resource pair as an exact seek: joining a materialized target
-- list lets PostgreSQL scan every grant for an identity before filtering targets.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id, :action::text AS action,
         NULLIF(:actor_id::text, '')::uuid AS actor_id, NULLIF(:principal_id::text, '')::uuid AS principal_id,
         :grant_roles::nullable(text[]) AS grant_roles, :include_global::boolean AS include_global
), keys AS MATERIALIZED (
  SELECT r.account_id, r.organization_id AS subject_id, 'identity'::text AS subject_kind,
         r.role AS subject_role, r.member, r.valid
  FROM jsonb_to_recordset(:roles::jsonb)
    AS r(account_id uuid, organization_id uuid, role text, member boolean, valid tstzrange)
  UNION ALL
  SELECT id, id, 'identity', '', true, '(,)'::tstzrange
  FROM input i CROSS JOIN LATERAL (VALUES (i.actor_id), (i.principal_id)) a(id) WHERE id IS NOT NULL
  UNION ALL
  SELECT id, '00000000-0000-0000-0000-000000000000'::uuid, 'active_accounts', '', true, '(,)'::tstzrange
  FROM input i CROSS JOIN LATERAL (VALUES (i.actor_id), (i.principal_id)) a(id) WHERE id IS NOT NULL
), authority AS MATERIALIZED (SELECT :at::timestamptz AS at), probes AS MATERIALIZED (
  SELECT k.*,
    ((SELECT count(*) FROM access.resource_grant g CROSS JOIN input i
      WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.action = i.action
        AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
        AND g.valid @> (SELECT at FROM authority)
    ) > 0 OR (SELECT count(*) FROM access.resource_grant g CROSS JOIN input i
      WHERE i.include_global AND g.route = 0
        AND g.resource_id = '00000000-0000-8000-8000-000000000000'::uuid AND g.action = i.action
        AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
        AND g.valid @> (SELECT at FROM authority)
    ) > 0 OR (SELECT count(*) FROM input i CROSS JOIN LATERAL unnest(i.grant_roles) role(grant_role)
      WHERE (SELECT count(*) FROM access.resource_role_grant g CROSS JOIN input i
        WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.grant_role = role.grant_role
          AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid @> (SELECT at FROM authority)
      ) > 0
    ) > 0 OR (SELECT count(*) FROM input i CROSS JOIN LATERAL unnest(i.grant_roles) role(grant_role)
      WHERE i.include_global AND (SELECT count(*) FROM access.resource_role_grant g
        WHERE g.route = 0 AND g.resource_id = '00000000-0000-8000-8000-000000000000'::uuid
          AND g.grant_role = role.grant_role
          AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid @> (SELECT at FROM authority)
      ) > 0
    ) > 0) AS granted,
    (k.subject_kind = 'identity' AND ((SELECT count(*) FROM access.resource_denial d CROSS JOIN input i
      WHERE d.route = i.route AND d.resource_id = i.resource_id AND d.action = i.action
        AND d.subject_id = k.subject_id AND d.subject_role = k.subject_role AND d.valid @> (SELECT at FROM authority)
    ) > 0 OR (SELECT count(*) FROM access.resource_denial d CROSS JOIN input i
      WHERE i.include_global AND d.route = 0
        AND d.resource_id = '00000000-0000-8000-8000-000000000000'::uuid AND d.action = i.action
        AND d.subject_id = k.subject_id AND d.subject_role = k.subject_role AND d.valid @> (SELECT at FROM authority)
    ) > 0)) AS denied
  FROM keys k
)
SELECT DISTINCT account_id::text AS "accountId", subject_id::text AS "organizationId"
FROM probes WHERE subject_role <> '' AND (granted OR denied);
