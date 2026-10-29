-- Probe one route; preparation combines page and Global Context candidates.
-- On Global, the B-tree companion seeks the last exact-key range starting
-- at or before T. Non-overlap makes it the only possible grant at T; check
-- containment after LIMIT so neither expired nor future history is enumerated.
-- Scalar role-grant/denial counts cannot become hashed ACL-wide EXISTS plans.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :action::text AS action,
         NULLIF(:actor_id::text, '')::uuid AS actor_id, NULLIF(:principal_id::text, '')::uuid AS principal_id
), targets AS MATERIALIZED (
  SELECT i.route, id AS resource_id FROM input i CROSS JOIN unnest(:resource_ids::uuid[]) id

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
    ((CASE WHEN i.route = 0 AND target.resource_id = '00000000-0000-8000-8000-000000000000'::uuid
      THEN (SELECT count(*) FROM (
        SELECT g.valid FROM access.resource_grant g
        WHERE g.route = 0 AND g.resource_id = '00000000-0000-8000-8000-000000000000'::uuid
          AND g.action = i.action AND g.subject_kind = k.subject_kind
          AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid <= tstzrange((SELECT at FROM authority), NULL, '[)')
        ORDER BY g.valid DESC LIMIT 1
      ) candidate WHERE candidate.valid @> (SELECT at FROM authority)) > 0
      ELSE (SELECT count(*) FROM access.resource_grant g
        WHERE g.route = i.route AND g.resource_id = target.resource_id AND g.action = i.action
          AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid @> (SELECT at FROM authority)) > 0
    END) OR (SELECT count(*) FROM unnest(:grant_roles::nullable(text[])) role(grant_role)
      WHERE (SELECT count(*) FROM access.resource_role_grant g
        WHERE g.route = i.route AND g.resource_id = target.resource_id AND g.grant_role = role.grant_role
          AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid @> (SELECT at FROM authority)
      ) > 0
    ) > 0) AS granted,
    (k.subject_kind = 'identity' AND (SELECT count(*) FROM access.resource_denial d
      WHERE d.route = i.route AND d.resource_id = target.resource_id AND d.action = i.action
        AND d.subject_id = k.subject_id AND d.subject_role = k.subject_role AND d.valid @> (SELECT at FROM authority)
    ) > 0) AS denied
  FROM keys k CROSS JOIN targets target CROSS JOIN input i
)
SELECT DISTINCT account_id::text AS "accountId", subject_id::text AS "organizationId"
FROM probes WHERE subject_role <> '' AND (granted OR denied);
