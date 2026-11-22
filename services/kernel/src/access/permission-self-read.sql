-- An unassigned actor with complete empty membership has exactly two grant keys.
-- Bind the general formula's assignment source even though this operand supplies no principal.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS id, :at::timestamptz AS at,
         :grant_roles::text[] AS grant_roles, clock_timestamp() < :deadline::timestamptz AS live
), keys AS MATERIALIZED (
  SELECT 'identity'::text AS kind, id FROM input
  UNION ALL
  SELECT 'active_accounts', '00000000-0000-0000-0000-000000000000'::uuid
), assignments AS (
  SELECT route, principal_id, request_id, assigned_actor_id, valid FROM access.principal_assignment
)
SELECT i.live AND NOT EXISTS (SELECT FROM assignments WHERE false) AND NOT EXISTS (
  SELECT FROM access.resource_denial d
  WHERE d.route = i.route AND d.resource_id = i.id AND d.subject_id = i.id
    AND d.subject_role = '' AND d.action = 'account:read' AND d.valid @> i.at
) AND (
  -- Non-overlap makes the last range starting at or before T the only possible grant.
  EXISTS (
    SELECT FROM keys k CROSS JOIN LATERAL (
      SELECT g.valid FROM access.resource_grant g
      WHERE ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid)
              >= ROW(i.route, i.id, k.kind, k.id, '', 'account:read', 'empty'::tstzrange)
        AND ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid)
              <= ROW(i.route, i.id, k.kind, k.id, '', 'account:read', tstzrange(i.at, NULL, '[)'))
      ORDER BY g.route DESC, g.resource_id DESC, g.subject_kind DESC, g.subject_id DESC, g.subject_role DESC,
               g.action DESC, g.valid DESC LIMIT 1
    ) candidate WHERE candidate.valid @> i.at
  ) OR EXISTS (
    SELECT FROM keys k CROSS JOIN LATERAL unnest(i.grant_roles) r(grant_role) CROSS JOIN LATERAL (
      SELECT g.valid FROM access.resource_role_grant g
      WHERE ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.grant_role,
                COALESCE(lower(g.valid), '-infinity'::timestamptz))
              >= ROW(i.route, i.id, k.kind, k.id, '', r.grant_role, '-infinity'::timestamptz)
        AND ROW(g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.grant_role,
                COALESCE(lower(g.valid), '-infinity'::timestamptz))
              <= ROW(i.route, i.id, k.kind, k.id, '', r.grant_role, i.at)
        AND g.valid <> '(,-infinity)'::tstzrange
      ORDER BY g.route DESC, g.resource_id DESC, g.subject_kind DESC, g.subject_id DESC, g.subject_role DESC,
               g.grant_role DESC, COALESCE(lower(g.valid), '-infinity'::timestamptz) DESC LIMIT 1
    ) candidate WHERE candidate.valid @> i.at
  )
) AS allowed FROM input i;
