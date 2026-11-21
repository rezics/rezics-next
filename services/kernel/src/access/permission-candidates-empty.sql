-- A complete empty membership inverse supplies no organization or Realm roles.
-- Keep every ACL source and column bound so missing dependencies still fail.
WITH grants AS (
  SELECT route, resource_id, subject_kind, subject_id, subject_role, action, valid FROM access.resource_grant
), role_grants AS (
  SELECT route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid FROM access.resource_role_grant
), denials AS (
  SELECT route, resource_id, subject_id, subject_role, action, valid FROM access.resource_denial
)
SELECT g.subject_id::text AS "accountId", d.subject_id::text AS "organizationId"
FROM grants g CROSS JOIN role_grants r CROSS JOIN denials d
WHERE false;
