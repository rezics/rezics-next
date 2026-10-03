-- Preserve the complete permission vocabulary from 600_realm_participation.
ALTER TABLE access.realm_admin_role DROP CONSTRAINT realm_admin_role_permissions_check;
ALTER TABLE access.realm_admin_role ADD CONSTRAINT realm_admin_role_permissions_check
  CHECK (cardinality(permissions) <= 8 AND permissions <@
    ARRAY['governance.moderate','governance.rule.publish','realm.members.manage',
      'realm.roles.manage','realm.settings.manage','review.decide','publication.adopt',
      'rating.configure']::text[]);

-- Default owner authority also applies to Realms enrolled before this release.
-- Any recorded rating grant, including a revoked one, prevents resurrection.
INSERT INTO access.permission_grant
  (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
SELECT gen_random_uuid(),b.owner_subject,b.owner_subject,'governance:realm:' || b.realm,
  'rating.configure',owner.valid_until,b.principal_id
FROM access.realm_admin_owner_bootstrap b
JOIN LATERAL (SELECT g.valid_until FROM access.permission_grant g
  WHERE g.recipient_subject = b.owner_subject AND g.scope_id = 'governance:realm:' || b.realm
    AND g.action = 'realm.owner' AND g.active AND g.membership_id IS NULL
    AND g.valid_until > clock_timestamp() ORDER BY g.valid_until DESC LIMIT 1) owner ON true
WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant g
  WHERE g.recipient_subject = b.owner_subject AND g.scope_id = 'governance:realm:' || b.realm
    AND g.action = 'rating.configure');

-- Commands retain the selected Realm grant and controller, not a replacement
-- selected at retry time. Realm role edits fence pending configuration.
CREATE TABLE access.realm_rating_admission (
  admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
  realm text NOT NULL REFERENCES access.realm_admin_revision(realm),
  realm_epoch bigint NOT NULL CHECK (realm_epoch >= 0),
  representation_id uuid NOT NULL REFERENCES access.representation(id),
  representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
  grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
  grant_generation bigint NOT NULL CHECK (grant_generation >= 0),
  subject_generation bigint NOT NULL CHECK (subject_generation >= 0),
  principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0)
);
CREATE TRIGGER realm_rating_admission_immutable BEFORE UPDATE OR DELETE
  ON access.realm_rating_admission FOR EACH ROW
  EXECUTE FUNCTION access.reject_role_record_mutation();
