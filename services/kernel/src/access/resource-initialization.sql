WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id, :resource_type::text AS resource_type,
         :creator_id::uuid AS creator_id, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), initialized AS (
  INSERT INTO access.resource_initialization (route, resource_id, resource_type, creator_id, initialized_at)
  SELECT route, resource_id, resource_type, creator_id, at FROM input
  RETURNING route, resource_id
), installed_grants AS (
  INSERT INTO access.resource_role_grant
    (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
  SELECT i.route, i.resource_id, r.subject_kind, r.subject_id, '', r.grant_role,
         tstzrange(i.at, NULL, '[)'), i.transaction_id
  FROM input i JOIN initialized n ON n.route = i.route AND n.resource_id = i.resource_id
  CROSS JOIN jsonb_to_recordset(:grants::jsonb) AS r(subject_kind text, subject_id uuid, grant_role text)
  RETURNING route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id
), role_provenance AS (
  -- The native grant trigger shares this statement's snapshot and cannot see the
  -- sibling initialization CTE. Carry the exact inserted rows forward instead.
  INSERT INTO access.resource_role_provenance
    (route, resource_id, resource_type, original_creator, account_id, grant_role, valid,
     side, grant_transaction, source_transaction)
  SELECT g.route, g.resource_id, i.resource_type, i.creator_id, g.subject_id, g.grant_role, g.valid,
         'new', g.transaction_id, i.transaction_id
  FROM input i
  JOIN initialized n ON n.route = i.route AND n.resource_id = i.resource_id
  JOIN installed_grants g ON g.route = n.route AND g.resource_id = n.resource_id
  WHERE g.subject_kind = 'identity' AND g.subject_role = ''
  RETURNING occurrence
)
SELECT grant_role FROM installed_grants;
