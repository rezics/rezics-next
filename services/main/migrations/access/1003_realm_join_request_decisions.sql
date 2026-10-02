CREATE TABLE access.realm_join_request_decision (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES access.realm_join_request(id),
  kind text NOT NULL CHECK (kind IN ('accepted','declined','withdrawn')),
  acting_subject text NOT NULL REFERENCES access.authority_subject(id),
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  membership_id uuid REFERENCES access.membership(id),
  membership_generation bigint,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'accepted' AND membership_id IS NOT NULL AND membership_generation IS NOT NULL AND membership_generation >= 1)
    OR (kind <> 'accepted' AND membership_id IS NULL AND membership_generation IS NULL))
);
-- This is a derived queue, maintained by triggers. Its primary key enforces
-- one pending request even when callers use different idempotency keys.
ALTER TABLE access.realm_join_request ADD CONSTRAINT realm_join_request_identity UNIQUE (id,realm,member);
CREATE TABLE access.realm_join_request_pending (
  realm text NOT NULL,
  member text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (realm,member),
  FOREIGN KEY (request_id,realm,member) REFERENCES access.realm_join_request(id,realm,member)
);
CREATE INDEX realm_join_request_pending_page ON access.realm_join_request_pending(realm,request_id);
INSERT INTO access.realm_join_request_pending (realm,member,request_id)
SELECT DISTINCT ON (realm,member) realm,member,id FROM access.realm_join_request
ORDER BY realm,member,created_at DESC,id DESC;
-- Close earlier duplicates without mutating their original intents.
INSERT INTO access.realm_join_request_decision (id,request_id,kind,acting_subject,principal_id,reason)
SELECT gen_random_uuid(),q.id,'withdrawn',q.member,b.principal_id,'Superseded duplicate request during request lifecycle migration'
FROM access.realm_join_request q JOIN access.realm_join_request_basis b ON b.request_id = q.id
WHERE NOT EXISTS (SELECT 1 FROM access.realm_join_request_pending p WHERE p.request_id = q.id);
CREATE FUNCTION access.enqueue_realm_join_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.realm_join_request_pending (realm,member,request_id) VALUES (NEW.realm,NEW.member,NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER realm_join_request_enqueue AFTER INSERT ON access.realm_join_request
  FOR EACH ROW EXECUTE FUNCTION access.enqueue_realm_join_request();
CREATE FUNCTION access.decide_realm_join_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM access.realm_join_request q JOIN access.realm_join_request_basis b ON b.request_id = q.id
    JOIN access.membership m ON m.id = NEW.membership_id AND m.kind = 'realm' AND m.owner_subject = q.realm
      AND m.member_subject = q.member AND m.state = 'joined' AND m.generation = NEW.membership_generation
      AND m.generation = q.membership_generation + 1 AND m.policy_revision = q.policy_revision
      AND m.terms_revision = b.terms_revision AND m.consent_reference = 'urn:rezics:realm-join-request:' || q.id::text
    WHERE q.id = NEW.request_id
  ) THEN RAISE EXCEPTION 'accepted request needs its exact membership episode' USING ERRCODE = '23514'; END IF;
  DELETE FROM access.realm_join_request_pending WHERE request_id = NEW.request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'join request is no longer pending' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER realm_join_request_decide AFTER INSERT ON access.realm_join_request_decision
  FOR EACH ROW EXECUTE FUNCTION access.decide_realm_join_request();
CREATE TRIGGER realm_join_request_decision_immutable BEFORE UPDATE OR DELETE
  ON access.realm_join_request_decision FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
