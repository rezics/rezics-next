-- Preserve all permissions admitted by 1026, adding independent question review.
ALTER TABLE access.realm_admin_role DROP CONSTRAINT realm_admin_role_permissions_check;
ALTER TABLE access.realm_admin_role ADD CONSTRAINT realm_admin_role_permissions_check
  CHECK (cardinality(permissions) <= 9 AND permissions <@
    ARRAY['governance.moderate','governance.rule.publish','realm.members.manage',
      'realm.roles.manage','realm.settings.manage','review.decide','publication.adopt',
      'rating.configure','rating.question-presentation.review']::text[]);

-- Existing owners receive the default once; a retired grant prevents resurrection.
INSERT INTO access.permission_grant
  (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
SELECT gen_random_uuid(),b.owner_subject,b.owner_subject,'governance:realm:' || b.realm,
  'rating.question-presentation.review',owner.valid_until,b.principal_id
FROM access.realm_admin_owner_bootstrap b
JOIN LATERAL (SELECT g.valid_until FROM access.permission_grant g
  WHERE g.recipient_subject = b.owner_subject AND g.scope_id = 'governance:realm:' || b.realm
    AND g.action = 'realm.owner' AND g.active AND g.membership_id IS NULL
    AND g.valid_until > clock_timestamp() ORDER BY g.valid_until DESC LIMIT 1) owner ON true
WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant g
  WHERE g.recipient_subject = b.owner_subject AND g.scope_id = 'governance:realm:' || b.realm
    AND g.action = 'rating.question-presentation.review');
