-- Platform opening is an Access grant, independently of resource authority.
-- Keep both previously admitted direct actions when widening the CHECK.
ALTER TABLE access.principal_permission_grant DROP CONSTRAINT principal_permission_grant_action_check;
ALTER TABLE access.principal_permission_grant ADD CONSTRAINT principal_permission_grant_action_check
  CHECK (action IN ('work.create','access.membership.manage.org') OR action LIKE 'platform:%');
ALTER TABLE access.group_permission_grant DROP CONSTRAINT group_permission_grant_action_check;
ALTER TABLE access.group_permission_grant ADD CONSTRAINT group_permission_grant_action_check
  CHECK (action = 'work.create' OR action LIKE 'platform:%');
INSERT INTO access.scope_gate(id) VALUES ('platform:access') ON CONFLICT DO NOTHING;

CREATE INDEX principal_platform_grant_lookup ON access.principal_permission_grant(principal_id,id)
  WHERE active AND action LIKE 'platform:%';
CREATE INDEX group_platform_grant_lookup ON access.group_permission_grant(group_id,id)
  WHERE active AND action LIKE 'platform:%';
CREATE INDEX platform_grant_holder_lookup ON access.principal_permission_grant(action,valid_until,principal_id)
  WHERE active AND action = 'platform:grant';

ALTER TABLE access.principal_permission_grant ADD CONSTRAINT principal_platform_grant_identity
  UNIQUE(id,issuer_subject,scope_id,action);
ALTER TABLE access.group_permission_grant ADD CONSTRAINT group_platform_grant_identity
  UNIQUE(id,issuer_subject,scope_id,action);

CREATE TABLE access.platform_grant_episode (
  id uuid PRIMARY KEY,
  principal_grant_id uuid UNIQUE REFERENCES access.principal_permission_grant(id),
  group_grant_id uuid UNIQUE REFERENCES access.group_permission_grant(id),
  issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
  permission text NOT NULL CHECK (permission LIKE 'platform:%'),
  scope_id text NOT NULL REFERENCES access.scope_gate(id),
  assigned_by_principal uuid NOT NULL REFERENCES access.principal(id),
  representation_id uuid REFERENCES access.representation(id),
  representation_generation bigint,
  ceiling_grant_id uuid REFERENCES access.permission_grant(id),
  ceiling_generation bigint,
  receipt text NOT NULL CHECK (receipt ~ '^urn:rezics:access-receipt:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(principal_grant_id,group_grant_id) = 1),
  FOREIGN KEY(principal_grant_id,issuer_subject,scope_id,permission)
    REFERENCES access.principal_permission_grant(id,issuer_subject,scope_id,action),
  FOREIGN KEY(group_grant_id,issuer_subject,scope_id,permission)
    REFERENCES access.group_permission_grant(id,issuer_subject,scope_id,action),
  CHECK ((representation_id IS NULL) = (representation_generation IS NULL)),
  CHECK ((ceiling_grant_id IS NULL) = (ceiling_generation IS NULL))
);
CREATE TRIGGER platform_grant_episode_immutable BEFORE UPDATE OR DELETE ON access.platform_grant_episode
  FOR EACH ROW EXECUTE FUNCTION access.reject_authority_control_mutation();
CREATE TABLE access.platform_grant_change_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  grant_id uuid NOT NULL REFERENCES access.platform_grant_episode(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id,idempotency_key)
);
CREATE TRIGGER platform_grant_change_receipt_immutable BEFORE UPDATE OR DELETE ON access.platform_grant_change_receipt
  FOR EACH ROW EXECUTE FUNCTION access.reject_authority_control_mutation();

-- Bound the indexed active set, including expired episodes awaiting revocation:
-- filtering an unlimited history of expired-but-active rows is not bounded.
CREATE FUNCTION access.bound_platform_grants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE live integer; individual integer;
BEGIN
  IF NEW.action NOT LIKE 'platform:%' OR NOT NEW.active THEN RETURN NEW; END IF;
  PERFORM 1 FROM access.scope_gate WHERE id = 'platform:access' FOR UPDATE;
  IF TG_TABLE_NAME = 'principal_permission_grant' THEN
    SELECT count(*),count(*) FILTER (WHERE action LIKE 'platform:use:%'
      AND substring(action FROM 14) !~ '^[a-z][a-z0-9-]*$') INTO live,individual
      FROM (SELECT action FROM access.principal_permission_grant WHERE principal_id = NEW.principal_id
        AND active AND action LIKE 'platform:%' LIMIT 129) grants;
  ELSE
    SELECT count(*),count(*) FILTER (WHERE action LIKE 'platform:use:%'
      AND substring(action FROM 14) !~ '^[a-z][a-z0-9-]*$') INTO live,individual
      FROM (SELECT action FROM access.group_permission_grant WHERE group_id = NEW.group_id
        AND active AND action LIKE 'platform:%' LIMIT 129) grants;
  END IF;
  IF live >= 128 OR (NEW.action LIKE 'platform:use:%' AND substring(NEW.action FROM 14) !~ '^[a-z][a-z0-9-]*$'
    AND individual >= 64) THEN
    RAISE EXCEPTION 'platform grant budget exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER principal_platform_bound BEFORE INSERT ON access.principal_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.bound_platform_grants();
CREATE TRIGGER group_platform_bound BEFORE INSERT ON access.group_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.bound_platform_grants();

-- Every membership/ancestry mutation invalidates the bounded platform cache.
-- This is one generation write, never a fan-out to affected viewers.
CREATE FUNCTION access.advance_platform_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME IN ('principal_permission_grant','group_permission_grant') THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.action NOT LIKE 'platform:%' THEN RETURN OLD; END IF;
    ELSIF NEW.action NOT LIKE 'platform:%' THEN RETURN NEW;
    END IF;
  END IF;
  UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = 'platform:access';
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER principal_platform_generation AFTER INSERT OR UPDATE OR DELETE ON access.principal_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.advance_platform_grants();
CREATE TRIGGER group_platform_generation AFTER INSERT OR UPDATE OR DELETE ON access.group_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.advance_platform_grants();
CREATE TRIGGER platform_member_generation AFTER INSERT OR UPDATE OR DELETE ON access.private_group_member
  FOR EACH ROW EXECUTE FUNCTION access.advance_platform_grants();
CREATE TRIGGER platform_membership_generation AFTER INSERT OR UPDATE OR DELETE ON access.private_membership
  FOR EACH ROW EXECUTE FUNCTION access.advance_platform_grants();
CREATE TRIGGER platform_ancestry_generation AFTER INSERT OR UPDATE OR DELETE ON access.recipient_group
  FOR EACH ROW EXECUTE FUNCTION access.advance_platform_grants();

CREATE FUNCTION access.keep_platform_grant_episode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action LIKE 'platform:%' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'platform grant episode is retained' USING ERRCODE = '23514'; END IF;
    IF (NEW.id,NEW.issuer_subject,NEW.scope_id,NEW.action,NEW.valid_until) IS DISTINCT FROM
       (OLD.id,OLD.issuer_subject,OLD.scope_id,OLD.action,OLD.valid_until) OR (NOT OLD.active AND NEW.active) THEN
      RAISE EXCEPTION 'platform grant episode is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'principal_permission_grant' THEN
      IF NEW.principal_id <> OLD.principal_id THEN
        RAISE EXCEPTION 'platform grant recipient is immutable' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.group_id <> OLD.group_id THEN
        RAISE EXCEPTION 'platform grant recipient is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER principal_platform_episode BEFORE UPDATE OR DELETE ON access.principal_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.keep_platform_grant_episode();
CREATE TRIGGER group_platform_episode BEFORE UPDATE OR DELETE ON access.group_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.keep_platform_grant_episode();

-- The permanent direct anchor prevents clock expiry or a group departure from
-- removing the final grant administrator. Other holders can have finite leases.
CREATE FUNCTION access.keep_platform_grant_administrator() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loses_anchor boolean;
BEGIN
  IF TG_TABLE_NAME = 'principal' THEN
    loses_anchor := OLD.active AND NOT NEW.active AND EXISTS (
      SELECT 1 FROM access.principal_permission_grant g WHERE g.principal_id = OLD.id
        AND g.action = 'platform:grant' AND g.active AND g.valid_until = 'infinity');
  ELSE
    loses_anchor := OLD.action = 'platform:grant' AND OLD.active AND OLD.valid_until = 'infinity'
      AND NOT NEW.active;
  END IF;
  IF loses_anchor THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('platform-grant-continuity',0));
    IF NOT EXISTS (SELECT 1 FROM access.principal_permission_grant g JOIN access.principal p ON p.id = g.principal_id
      WHERE g.action = 'platform:grant' AND g.active AND g.valid_until = 'infinity' AND p.active
        AND CASE WHEN TG_TABLE_NAME = 'principal' THEN p.id <> OLD.id ELSE g.id <> OLD.id END) THEN
      RAISE EXCEPTION 'last permanent platform:grant holder cannot be removed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_grant_continuity BEFORE UPDATE ON access.principal_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.keep_platform_grant_administrator();
CREATE TRIGGER platform_principal_continuity BEFORE UPDATE OF active ON access.principal
  FOR EACH ROW EXECUTE FUNCTION access.keep_platform_grant_administrator();

-- Saved admissions pin the grant-derived proof digest rather than a singleton
-- designation. The singleton stays solely for the deferred rate-limit reader.
ALTER TABLE access.platform_administrator_admission
  DROP CONSTRAINT platform_administrator_admission_receipt_fkey;

CREATE FUNCTION access.seed_platform_grants(principal uuid, designation text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actor text; item record; grant_id uuid;
BEGIN
  SELECT r.subject_id INTO actor FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.principal_id = principal AND r.action = 'agent.control' AND r.active
      AND r.valid_until > clock_timestamp() AND s.active ORDER BY r.id LIMIT 1;
  IF actor IS NULL THEN
    SELECT agent_id INTO actor FROM access.agent_provision WHERE principal_id = principal AND state = 'active' ORDER BY agent_id LIMIT 1;
  END IF;
  IF actor IS NULL THEN
    actor := 'https://rezics.com/id/00000000-0000-4000-8000-000000000129';
    INSERT INTO access.authority_subject(id,kind) VALUES (actor,'institution') ON CONFLICT DO NOTHING;
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('platform:grant','platform:access'), ('platform:use:platform-admin','platform:access'),
    ('platform:resource:rating.context.create','rating:context:target:https://rezics.com/id/00000000-0000-8000-8000-676c6f62616c'),
    ('platform:resource:work.create','work:create:root'),
    ('platform:resource:space.create','space:create:root'),
    ('platform:resource:semantic.change','semantic:create:root'),
    ('platform:resource:catalogue.verify','catalogue:verify:root'),
    ('platform:resource:classification.proposition.define','classification:define:global'),
    ('platform:resource:media.labels.protect','media:protect:*'),
    ('platform:resource:media.conceal.protect','media:protect:*'),
    ('platform:resource:zone.edit','zone:edit:*'),
    ('platform:resource:media.campaign','zone:edit:*'),
    ('platform:resource:zone.official','zone:official:*'),
    ('platform:resource:semantic.read','semantic:read:*'),
    ('platform:resource:semantic.change','semantic:edit:*'),
    ('platform:resource:lexicon.presentation.change','semantic:edit:*'),
    ('platform:resource:lexicon.presentation.review','semantic:edit:*'),
    ('platform:resource:rating.question-presentation.change','rating:presentation:*'),
    ('platform:resource:rating.question-presentation.review','rating:presentation:*'),
    ('platform:resource:governance.moderate','governance:platform'),
    ('platform:resource:governance.rights.decide','governance:platform'),
    ('platform:resource:governance.safety.evidence','governance:platform'),
    ('platform:resource:governance.appeal','governance:platform')
  ) AS permissions(action,scope) LOOP
    INSERT INTO access.scope_gate(id) VALUES (item.scope) ON CONFLICT DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM access.principal_permission_grant WHERE principal_id = principal
      AND action = item.action AND scope_id = item.scope) THEN
      grant_id := gen_random_uuid();
      INSERT INTO access.principal_permission_grant(id,issuer_subject,principal_id,scope_id,action,valid_until)
        VALUES (grant_id,actor,principal,item.scope,item.action,'infinity');
      INSERT INTO access.platform_grant_episode(id,principal_grant_id,issuer_subject,permission,scope_id,assigned_by_principal,receipt)
        VALUES (grant_id,grant_id,actor,item.action,item.scope,principal,designation);
    END IF;
    IF item.action LIKE 'platform:resource:%' THEN
      INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        SELECT gen_random_uuid(),actor,actor,item.scope,'access.grant.assign.' || substring(item.action FROM 19),'infinity'
        WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant WHERE recipient_subject = actor
          AND scope_id = item.scope AND action = 'access.grant.assign.' || substring(item.action FROM 19));
    END IF;
  END LOOP;
  INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    SELECT gen_random_uuid(),actor,actor,'platform:access','access.grant.assign.platform','infinity'
    WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant WHERE recipient_subject = actor
      AND scope_id = 'platform:access' AND action = 'access.grant.assign.platform');
END $$;
SELECT access.seed_platform_grants(principal_id,receipt) FROM access.platform_administrator WHERE singleton;

CREATE INDEX platform_grant_issuer_page ON access.platform_grant_episode(issuer_subject,id);
