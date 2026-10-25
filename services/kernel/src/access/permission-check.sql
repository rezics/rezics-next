-- Scalar counts are bounded by exact identity/action and native valid-range
-- keys (one grant per key, at most three denial reasons). They cannot become
-- an alternative hashed EXISTS subplan that enumerates the resource ACL.
-- Access checks the requested scope in process only when the trusted floor is false.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id, :action::text AS action,
         NULLIF(:actor_id::text, '')::uuid AS actor_id, NULLIF(:principal_id::text, '')::uuid AS principal_id, :anonymous::boolean AS anonymous, COALESCE(:floor::nullable(boolean), false) AS floor, :deadline::timestamptz AS deadline
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
), probes AS MATERIALIZED (
  SELECT k.*,
    ((SELECT count(*) FROM access.resource_grant g CROSS JOIN input i
      WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.action = i.action
        AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
        AND g.valid @> (SELECT at FROM authority)
    ) > 0 OR (SELECT count(*) FROM unnest(:grant_roles::nullable(text[])) role(grant_role)
      WHERE (SELECT count(*) FROM access.resource_role_grant g CROSS JOIN input i
        WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.grant_role = role.grant_role
          AND g.subject_kind = k.subject_kind AND g.subject_id = k.subject_id AND g.subject_role = k.subject_role
          AND g.valid @> (SELECT at FROM authority)
      ) > 0
    ) > 0) AS granted,
    (k.subject_kind = 'identity' AND (SELECT count(*) FROM access.resource_denial d CROSS JOIN input i
      WHERE d.route = i.route AND d.resource_id = i.resource_id AND d.action = i.action
        AND d.subject_id = k.subject_id AND d.subject_role = k.subject_role AND d.valid @> (SELECT at FROM authority)
    ) > 0) AS denied
  FROM keys k
)
SELECT (
  t.observed_at < i.deadline
  AND :evidence_valid::tstzrange @> t.at
  AND (i.floor OR (NOT i.anonymous AND (
    EXISTS (SELECT 1 FROM probes p WHERE p.account_id = i.actor_id AND p.granted AND p.member AND p.valid @> t.at)
    AND (i.principal_id IS NULL OR EXISTS (
      SELECT 1 FROM probes p WHERE p.account_id = i.principal_id AND p.granted AND p.member AND p.valid @> t.at
    ))
  )))
  AND NOT EXISTS (
    -- All current group hits require authoritative role/absence evidence.
    -- A new matching denial or grant cannot reuse an unprepared group key.
    SELECT 1 FROM probes p
    WHERE (p.denied AND p.member) OR (p.subject_role <> '' AND (p.granted OR p.denied) AND NOT (p.valid @> t.at))
  )
) AS allowed
FROM input i CROSS JOIN authority t;
