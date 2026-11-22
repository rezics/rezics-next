-- Observe the preparation clock and the complete inverse for one self-account read.
-- An empty inverse needs no anchored role reads. Bind the same ACL sources as the empty candidate query.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), grants AS (
  SELECT route, resource_id, subject_kind, subject_id, subject_role, action, valid FROM access.resource_grant
), role_grants AS (
  SELECT route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid FROM access.resource_role_grant
), denials AS (
  SELECT route, resource_id, subject_id, subject_role, action, valid FROM access.resource_denial
)
SELECT COALESCE(NULLIF(:at::text, '')::timestamptz, clock_timestamp())::text AS at,
       clock_timestamp()::text AS "databaseAt",
       EXISTS (SELECT FROM access.membership_inverse_coverage c
               WHERE c.route = i.route AND c.account_id = i.account_id AND c.complete)
       AND NOT EXISTS (SELECT FROM access.membership_inverse m
                       WHERE m.route = i.route AND m.account_id = i.account_id AND m.kind IN ('organization', 'realm'))
       AND NOT EXISTS (SELECT FROM grants g CROSS JOIN role_grants r CROSS JOIN denials d WHERE false) AS "emptyRoles"
FROM input i;
