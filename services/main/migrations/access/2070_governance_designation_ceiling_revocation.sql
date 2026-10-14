-- Keep the existing trigger and bootstrap owner. Only deployment assignment
-- ceilings end with the immutable original designation; ordinary grants survive.
CREATE OR REPLACE FUNCTION access.revoke_source_publication_assignment_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id = (SELECT e.principal_grant_id FROM access.platform_grant_episode e
    WHERE e.permission = 'platform:grant' AND e.principal_grant_id IS NOT NULL
    ORDER BY e.created_at,e.id LIMIT 1) THEN
    UPDATE access.permission_grant SET active = false
    WHERE assigned_by_principal = NEW.principal_id AND active
      AND (scope_id,action) IN (
        ('work:publish:*','access.grant.assign.work.publish'),
        ('governance:platform','access.grant.assign.governance.rule.publish'),
        ('realm:attach:*','access.grant.assign.realm.attach'));
  END IF;
  RETURN NULL;
END $$;

-- Revocation may predate this repair. A later ordinary governance grant must
-- neither hide the revoked original designation nor become a cleanup target.
WITH original AS (
  SELECT principal_grant_id FROM access.platform_grant_episode
  WHERE permission = 'platform:grant' AND principal_grant_id IS NOT NULL
  ORDER BY created_at,id LIMIT 1
)
UPDATE access.permission_grant c SET active = false
FROM original o JOIN access.principal_permission_grant g ON g.id = o.principal_grant_id
WHERE NOT g.active AND c.assigned_by_principal = g.principal_id AND c.active
  AND (c.scope_id,c.action) IN (
    ('work:publish:*','access.grant.assign.work.publish'),
    ('governance:platform','access.grant.assign.governance.rule.publish'),
    ('realm:attach:*','access.grant.assign.realm.attach'));
