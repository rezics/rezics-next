-- unbound: one permission formula probes the bounded read batch or single-route page and the fixed Global Context for governance reach.
-- The B-tree companions seek the last exact-key range starting
-- at or before T. Non-overlap makes it the only possible grant at T; check
-- containment after LIMIT so neither expired nor future history is enumerated.
-- Scalar role-grant/denial counts cannot become hashed ACL-wide EXISTS plans.
-- The optional explicit branch uses this same formula with no floor or role grants.
-- Access checks scope in process for the authenticated grant and explicit branches.
-- policy_core is true only for an exact registered action/type profile. SQL booleans remain the fallback when a
-- point type is absent/ambiguous or a batch supplies an unregistered type.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :action::text AS action,
         :resource_ids::uuid[] AS resource_ids, COALESCE(:batch::nullable(boolean), false) AS batch, :include_global::boolean AS include_global,
         NULLIF(:actor_id::text, '')::uuid AS actor_id, NULLIF(:principal_id::text, '')::uuid AS principal_id,
         :assignment_route::nullable(integer) AS assignment_route,
         NULLIF(:assignment_request_id::nullable(text), '')::uuid AS assignment_request_id,
         NULLIF(:authenticated_resource_id::nullable(text), '')::uuid AS authenticated_resource_id,
         :authenticated_buyer_ids::nullable(uuid[]) AS authenticated_buyer_ids,
         :anonymous::boolean AS anonymous, COALESCE(:own_account::nullable(boolean), false) AS own_account,
         COALESCE(:floor::nullable(boolean), false) AS floor, COALESCE(:policy_core::nullable(boolean), false) AS policy_core,
         :deadline::timestamptz AS deadline
), branches AS MATERIALIZED (
  SELECT false AS explicit, false AS public
  UNION ALL
  SELECT true, false WHERE COALESCE(:include_explicit::nullable(boolean), false)
  UNION ALL
  SELECT false, true WHERE COALESCE(:include_public::nullable(boolean), false)
), targets AS MATERIALIZED (
  SELECT CASE WHEN i.batch
    THEN ('x' || substr(id::text, 25, 4))::bit(16)::integer ELSE i.route END AS route,
    id AS resource_id FROM input i CROSS JOIN unnest(i.resource_ids) id
  UNION
  SELECT 0, '00000000-0000-8000-8000-000000000000'::uuid FROM input i WHERE i.include_global
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
), authority AS MATERIALIZED (
  SELECT COALESCE(NULLIF(:at::nullable(text), '')::timestamptz, transaction_timestamp()) AS at,
         clock_timestamp() AS observed_at
), assignment AS MATERIALIZED (
  SELECT i.assignment_request_id IS NULL OR EXISTS (
    SELECT 1 FROM (
      -- Keep the exact anchor in primary-key order even when other consumers add
      -- differently ordered discovery indexes over the same columns. Check the
      -- assignee and interval after this unique-key seek.
      SELECT p.assigned_actor_id, p.valid FROM access.principal_assignment p
      WHERE ROW(p.route, p.principal_id, p.request_id)
            >= ROW(i.assignment_route, i.principal_id, i.assignment_request_id)
        AND ROW(p.route, p.principal_id, p.request_id)
            <= ROW(i.assignment_route, i.principal_id, i.assignment_request_id)
      ORDER BY p.route, p.principal_id, p.request_id
      OFFSET 0
    ) p WHERE p.assigned_actor_id = i.actor_id AND p.valid @> t.at
  ) AS valid
  FROM input i CROSS JOIN authority t
), probe_sources AS MATERIALIZED (
  SELECT target.route, target.resource_id, b.explicit, b.public, k.*,
    COALESCE(NOT b.public AND NOT i.batch AND NOT i.anonymous
       AND cardinality(i.resource_ids) = 1 AND i.action = 'edition:read' AND target.route = i.route
       AND target.resource_id = i.authenticated_resource_id
       AND k.subject_kind = 'identity' AND k.subject_role = '' AND k.subject_id = k.account_id
       AND k.account_id = ANY(i.authenticated_buyer_ids), false) AS authenticated_benefit_granted,
    (i.own_account AND target.resource_id = i.actor_id AND k.subject_kind = 'identity'
       AND k.subject_id = i.actor_id AND k.subject_role = '') AS own_account_granted,
    CASE WHEN target.route = 0 AND target.resource_id = '00000000-0000-8000-8000-000000000000'::uuid
      THEN (SELECT count(*) FROM (
        SELECT g.valid FROM access.resource_grant g
        WHERE g.route = 0 AND g.resource_id = '00000000-0000-8000-8000-000000000000'::uuid
          AND ROW(g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid)
            >= ROW(k.subject_kind, k.subject_id, k.subject_role, i.action, 'empty'::tstzrange)
          AND ROW(g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid)
            <= ROW(k.subject_kind, k.subject_id, k.subject_role, i.action,
                   tstzrange((SELECT at FROM authority), NULL, '[)'))
        ORDER BY g.subject_kind DESC, g.subject_id DESC, g.subject_role DESC,
                 g.action DESC, g.valid DESC LIMIT 1
      ) candidate WHERE candidate.valid @> (SELECT at FROM authority)) > 0
      ELSE (SELECT count(*) FROM (
        SELECT g.valid FROM access.resource_grant g
        WHERE ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid)
            >= ROW(target.route, target.resource_id, k.subject_kind, k.subject_id, k.subject_role, i.action,
                   'empty'::tstzrange)
          AND ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid)
            <= ROW(target.route, target.resource_id, k.subject_kind, k.subject_id, k.subject_role, i.action,
                   tstzrange((SELECT at FROM authority), NULL, '[)'))
        ORDER BY g.route DESC, g.resource_id DESC, g.subject_kind DESC, g.subject_id DESC,
                 g.subject_role DESC, g.action DESC, g.valid DESC LIMIT 1
      ) candidate WHERE candidate.valid @> (SELECT at FROM authority)) > 0
    END AS action_granted,
    (SELECT count(*) FROM unnest(:grant_roles::nullable(text[])) role(grant_role)
      WHERE (SELECT count(*) FROM (
        SELECT g.valid FROM access.resource_role_grant g
        WHERE ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.grant_role,
                  COALESCE(lower(g.valid), '-infinity'::timestamptz))
            >= ROW(target.route, target.resource_id, k.subject_kind, k.subject_id, k.subject_role, role.grant_role,
                   '-infinity'::timestamptz)
          AND ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.grant_role,
                  COALESCE(lower(g.valid), '-infinity'::timestamptz))
            <= ROW(target.route, target.resource_id, k.subject_kind, k.subject_id, k.subject_role, role.grant_role,
                   (SELECT at FROM authority))
        ORDER BY g.route DESC, g.resource_id DESC, g.subject_kind DESC, g.subject_id DESC,
                 g.subject_role DESC, g.grant_role DESC,
                 COALESCE(lower(g.valid), '-infinity'::timestamptz) DESC LIMIT 1
      ) candidate WHERE candidate.valid @> (SELECT at FROM authority)) > 0
    ) > 0 AS resource_role_granted,
    (k.subject_kind = 'identity' AND (SELECT count(*) FROM access.resource_denial d
      WHERE d.route = target.route AND d.resource_id = target.resource_id AND d.action = i.action
        AND d.subject_id = k.subject_id AND d.subject_role = k.subject_role AND d.valid @> (SELECT at FROM authority)
    ) > 0) AS denied
  FROM keys k CROSS JOIN targets target CROSS JOIN input i CROSS JOIN branches b
), probes AS MATERIALIZED (
  SELECT source.*,
    (source.authenticated_benefit_granted AND NOT source.explicit OR source.own_account_granted OR
     source.action_granted OR (source.resource_role_granted AND NOT source.explicit)) AS granted
  FROM probe_sources source
), decisions AS MATERIALIZED (
SELECT target.route, target.resource_id, b.explicit, b.public,
  CASE WHEN i.policy_core THEN NULL::boolean ELSE (
    t.observed_at < i.deadline
    AND assignment.valid
    AND (((i.floor OR b.public) AND NOT b.explicit) OR (NOT i.anonymous AND (
      COALESCE(bool_or(p.account_id = i.actor_id AND p.granted AND p.member AND p.valid @> t.at), false)
      AND (i.principal_id IS NULL OR COALESCE(bool_or(
        p.account_id = i.principal_id AND p.granted AND p.member AND p.valid @> t.at
      ), false))
    )))
    -- Every current group hit needs authoritative positive or negative role evidence.
    AND NOT COALESCE(bool_or(
      (p.denied AND p.member) OR (p.subject_role <> '' AND (p.granted OR p.denied) AND NOT (p.valid @> t.at))
    ), false)
  ) END AS allowed,
  COALESCE(bool_or(p.account_id = i.actor_id AND p.action_granted AND p.member AND p.valid @> t.at), false) AS actor_action_grant,
  COALESCE(bool_or(p.account_id = i.actor_id AND p.resource_role_granted AND p.member AND p.valid @> t.at), false) AS actor_resource_role_grant,
  COALESCE(bool_or(p.account_id = i.actor_id AND p.own_account_granted AND p.member AND p.valid @> t.at), false) AS actor_own_account_grant,
  COALESCE(bool_or(p.account_id = i.actor_id AND p.authenticated_benefit_granted AND p.member AND p.valid @> t.at), false) AS actor_authenticated_benefit_grant,
  COALESCE(bool_or(p.account_id = i.principal_id AND p.action_granted AND p.member AND p.valid @> t.at), false) AS principal_action_grant,
  COALESCE(bool_or(p.account_id = i.principal_id AND p.resource_role_granted AND p.member AND p.valid @> t.at), false) AS principal_resource_role_grant,
  COALESCE(bool_or(p.account_id = i.principal_id AND p.own_account_granted AND p.member AND p.valid @> t.at), false) AS principal_own_account_grant,
  COALESCE(bool_or(p.account_id = i.principal_id AND p.authenticated_benefit_granted AND p.member AND p.valid @> t.at), false) AS principal_authenticated_benefit_grant,
  COALESCE(bool_or(
    (p.denied AND p.member) OR
    (p.subject_role <> '' AND (p.granted OR p.denied) AND NOT (p.valid @> t.at))
  ), false) AS denied,
  assignment.valid AS assignment_valid,
  t.observed_at < i.deadline AS deadline_live
FROM input i CROSS JOIN authority t CROSS JOIN assignment CROSS JOIN targets target CROSS JOIN branches b
LEFT JOIN probes p ON p.route = target.route AND p.resource_id = target.resource_id AND p.explicit = b.explicit AND p.public = b.public
GROUP BY target.route, target.resource_id, b.explicit, b.public, t.observed_at, t.at, assignment.valid,
         i.deadline, i.floor, i.anonymous, i.principal_id, i.policy_core
)
SELECT local.resource_id::text AS "resourceId",
       CASE WHEN i.policy_core THEN NULL::boolean ELSE (local.allowed OR COALESCE(global.allowed, false)) END AS allowed,
       (NOT local.allowed AND COALESCE(global.allowed, false)) AS "governanceReach",
       CASE WHEN i.policy_core THEN NULL::boolean ELSE COALESCE(explicit_local.allowed OR explicit_global.allowed, false) END AS explicit,
       CASE WHEN i.policy_core THEN NULL::boolean ELSE COALESCE(public_local.allowed OR public_global.allowed, false) END AS "publicAllowed",
       local.assignment_valid AS "assignmentValid",
       local.denied AS "localDenied",
       local.actor_action_grant AS "actorActionGrant",
       local.actor_resource_role_grant AS "actorResourceRoleGrant",
       local.actor_own_account_grant AS "actorOwnAccountGrant",
       local.actor_authenticated_benefit_grant AS "actorAuthenticatedBenefitGrant",
       local.principal_action_grant AS "principalActionGrant",
       local.principal_resource_role_grant AS "principalResourceRoleGrant",
       local.principal_own_account_grant AS "principalOwnAccountGrant",
       local.principal_authenticated_benefit_grant AS "principalAuthenticatedBenefitGrant",
       global.denied AS "globalDenied",
       global.actor_action_grant AS "globalActorActionGrant",
       global.actor_resource_role_grant AS "globalActorResourceRoleGrant",
       global.actor_own_account_grant AS "globalActorOwnAccountGrant",
       global.actor_authenticated_benefit_grant AS "globalActorAuthenticatedBenefitGrant",
       global.principal_action_grant AS "globalPrincipalActionGrant",
       global.principal_resource_role_grant AS "globalPrincipalResourceRoleGrant",
       global.principal_own_account_grant AS "globalPrincipalOwnAccountGrant",
       global.principal_authenticated_benefit_grant AS "globalPrincipalAuthenticatedBenefitGrant",
       explicit_local.denied AS "explicitLocalDenied",
       explicit_local.actor_action_grant AS "explicitActorActionGrant",
       explicit_local.actor_resource_role_grant AS "explicitActorResourceRoleGrant",
       explicit_local.actor_own_account_grant AS "explicitActorOwnAccountGrant",
       explicit_local.actor_authenticated_benefit_grant AS "explicitActorAuthenticatedBenefitGrant",
       explicit_local.principal_action_grant AS "explicitPrincipalActionGrant",
       explicit_local.principal_resource_role_grant AS "explicitPrincipalResourceRoleGrant",
       explicit_local.principal_own_account_grant AS "explicitPrincipalOwnAccountGrant",
       explicit_local.principal_authenticated_benefit_grant AS "explicitPrincipalAuthenticatedBenefitGrant",
       explicit_global.denied AS "explicitGlobalDenied",
       explicit_global.actor_action_grant AS "explicitGlobalActorActionGrant",
       explicit_global.actor_resource_role_grant AS "explicitGlobalActorResourceRoleGrant",
       explicit_global.actor_own_account_grant AS "explicitGlobalActorOwnAccountGrant",
       explicit_global.actor_authenticated_benefit_grant AS "explicitGlobalActorAuthenticatedBenefitGrant",
       explicit_global.principal_action_grant AS "explicitGlobalPrincipalActionGrant",
       explicit_global.principal_resource_role_grant AS "explicitGlobalPrincipalResourceRoleGrant",
       explicit_global.principal_own_account_grant AS "explicitGlobalPrincipalOwnAccountGrant",
       explicit_global.principal_authenticated_benefit_grant AS "explicitGlobalPrincipalAuthenticatedBenefitGrant",
       (SELECT at::text FROM authority) AS at,
       ((SELECT observed_at FROM authority) < i.deadline) AS live
FROM decisions local CROSS JOIN input i
LEFT JOIN decisions global ON i.include_global AND global.route = 0
  AND global.resource_id = '00000000-0000-8000-8000-000000000000'::uuid AND NOT global.explicit AND NOT global.public
LEFT JOIN decisions explicit_local ON explicit_local.explicit AND NOT explicit_local.public
  AND explicit_local.route = local.route AND explicit_local.resource_id = local.resource_id
LEFT JOIN decisions explicit_global ON i.include_global AND explicit_global.explicit AND NOT explicit_global.public AND explicit_global.route = 0
  AND explicit_global.resource_id = '00000000-0000-8000-8000-000000000000'::uuid
LEFT JOIN decisions public_local ON public_local.public
  AND public_local.route = local.route AND public_local.resource_id = local.resource_id
LEFT JOIN decisions public_global ON i.include_global AND public_global.public AND public_global.route = 0
  AND public_global.resource_id = '00000000-0000-8000-8000-000000000000'::uuid
WHERE NOT local.explicit AND NOT local.public
  AND (i.batch OR local.route = i.route)
  AND local.resource_id = ANY(i.resource_ids);
