ALTER TABLE access.realm_admin_role DROP CONSTRAINT realm_admin_role_permissions_check;
ALTER TABLE access.realm_admin_role ADD CONSTRAINT realm_admin_role_permissions_check
  CHECK (cardinality(permissions) <= 7 AND permissions <@
    ARRAY['governance.moderate','governance.rule.publish','realm.members.manage',
      'realm.roles.manage','realm.settings.manage','review.decide','publication.adopt']::text[]);
ALTER TABLE access.realm_admin_settings ADD COLUMN self_join boolean NOT NULL DEFAULT false;

-- Upgrade only existing, active person controllers. A retired consent grant is
-- evidence of revocation, so an upgrade must not manufacture a replacement.
INSERT INTO access.permission_grant
  (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
SELECT gen_random_uuid(),p.agent_id,p.agent_id,'work:create:root','access.membership.consent',
  r.valid_until,p.principal_id
FROM access.agent_provision p JOIN access.representation r ON r.id = p.representation_id
JOIN access.principal a ON a.id = p.principal_id AND a.active
JOIN access.authority_subject s ON s.id = p.agent_id AND s.active
WHERE p.state = 'active' AND p.agent_kind = 'person' AND r.active
  AND r.action = 'agent.control' AND r.valid_until > clock_timestamp()
  AND NOT EXISTS (SELECT 1 FROM access.permission_grant g WHERE g.recipient_subject = p.agent_id
    AND g.scope_id = 'work:create:root' AND g.action = 'access.membership.consent');

INSERT INTO access.scope_gate (id)
SELECT prefix || b.realm FROM access.realm_admin_owner_bootstrap b
CROSS JOIN unnest(ARRAY['review:decide:','publication:adopt:']) AS prefix ON CONFLICT DO NOTHING;
INSERT INTO access.permission_grant
  (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
SELECT gen_random_uuid(),b.owner_subject,b.owner_subject,x.prefix || b.realm,x.action,
  owner.valid_until,b.principal_id FROM access.realm_admin_owner_bootstrap b
JOIN LATERAL (SELECT g.valid_until FROM access.permission_grant g
  WHERE g.recipient_subject = b.owner_subject AND g.scope_id = 'governance:realm:' || b.realm
    AND g.action = 'realm.owner' AND g.active AND g.membership_id IS NULL
    AND g.valid_until > clock_timestamp() ORDER BY g.valid_until DESC LIMIT 1) owner ON true
CROSS JOIN (VALUES ('review:decide:','review.decide'),('publication:adopt:','publication.adopt')) x(prefix,action)
WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant g WHERE g.recipient_subject = b.owner_subject
  AND g.scope_id = x.prefix || b.realm AND g.action = x.action);

CREATE TABLE access.realm_invitation (
  id uuid PRIMARY KEY,
  realm text NOT NULL REFERENCES access.realm_admin_revision(realm),
  member text NOT NULL REFERENCES access.authority_subject(id),
  inviter text NOT NULL REFERENCES access.authority_subject(id),
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  principal_epoch bigint NOT NULL,
  representation_id uuid NOT NULL REFERENCES access.representation(id),
  representation_generation bigint NOT NULL,
  grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
  grant_generation bigint NOT NULL,
  subject_generation bigint NOT NULL,
  membership_generation bigint NOT NULL,
  policy_revision bigint NOT NULL,
  terms_revision text NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','declined','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  responded_at timestamptz,
  CHECK ((state = 'pending') = (responded_at IS NULL))
);
CREATE INDEX realm_invitation_inbox ON access.realm_invitation (member,id);
CREATE INDEX realm_invitation_realm ON access.realm_invitation (realm,id);
CREATE TABLE access.realm_join_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id,idempotency_key)
);
CREATE TRIGGER realm_join_receipt_immutable BEFORE UPDATE OR DELETE ON access.realm_join_receipt
  FOR EACH ROW EXECUTE FUNCTION access.reject_membership_record_mutation();

-- Consent belongs to an exact membership episode. Leaving and rejoining never
-- restores listing or an editorial feature chosen for the previous episode.
CREATE TABLE access.realm_roster_listing (
  membership_id uuid NOT NULL REFERENCES access.membership(id),
  membership_generation bigint NOT NULL,
  realm text NOT NULL,
  member text NOT NULL,
  listed boolean NOT NULL DEFAULT false,
  featured boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (membership_id,membership_generation)
);
CREATE INDEX realm_roster_public_page ON access.realm_roster_listing (realm,member) WHERE listed;
CREATE INDEX realm_roster_featured_page ON access.realm_roster_listing (realm,member) WHERE listed AND featured;
