-- IAM25: the only admitted selector is the current private Org member set.
-- Selector identity is a versioned, immutable Access object, never an Agent.
CREATE TABLE access.eligible_org_member_set (
  id uuid PRIMARY KEY,
  owner_subject text NOT NULL REFERENCES access.authority_subject(id),
  version bigint NOT NULL CHECK (version = 1),
  predicate text NOT NULL CHECK (predicate = 'current-private-org-members'),
  UNIQUE (owner_subject, version),
  UNIQUE (id, owner_subject, version)
);
CREATE TRIGGER eligible_org_member_set_immutable BEFORE UPDATE OR DELETE
  ON access.eligible_org_member_set FOR EACH ROW
  EXECUTE FUNCTION access.reject_representation_record_mutation();

ALTER TABLE access.org_roster_scope
  ADD CONSTRAINT org_roster_scope_owner_scope_unique UNIQUE (owner_subject, scope_id);

CREATE TABLE access.eligible_org_member_set_grant (
  id uuid PRIMARY KEY,
  selector_id uuid NOT NULL,
  recipient_subject text NOT NULL,
  selector_version bigint NOT NULL CHECK (selector_version = 1),
  issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
  scope_id text NOT NULL REFERENCES access.scope_gate(id),
  action text NOT NULL CHECK (action = 'access.membership.manage.org'),
  active boolean NOT NULL DEFAULT true,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  valid_until timestamptz NOT NULL,
  assigned_by_principal uuid NOT NULL REFERENCES access.principal(id),
  issuer_generation bigint NOT NULL CHECK (issuer_generation >= 0),
  recipient_generation bigint NOT NULL CHECK (recipient_generation >= 0),
  FOREIGN KEY (selector_id, recipient_subject, selector_version)
    REFERENCES access.eligible_org_member_set(id, owner_subject, version),
  FOREIGN KEY (issuer_subject, scope_id)
    REFERENCES access.org_roster_scope(owner_subject, scope_id)
);
CREATE INDEX eligible_org_member_set_grant_issuer_page
  ON access.eligible_org_member_set_grant (issuer_subject, id);
CREATE INDEX eligible_org_member_set_grant_selector_active
  ON access.eligible_org_member_set_grant (selector_id, id) WHERE active;
CREATE FUNCTION access.keep_eligible_org_member_set_grant_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.selector_id, NEW.recipient_subject, NEW.selector_version,
      NEW.issuer_subject, NEW.scope_id, NEW.action, NEW.valid_until,
      NEW.assigned_by_principal, NEW.issuer_generation, NEW.recipient_generation)
      IS DISTINCT FROM
     (OLD.id, OLD.selector_id, OLD.recipient_subject, OLD.selector_version,
      OLD.issuer_subject, OLD.scope_id, OLD.action, OLD.valid_until,
      OLD.assigned_by_principal, OLD.issuer_generation, OLD.recipient_generation)
      OR (NOT OLD.active AND NEW.active) THEN
    RAISE EXCEPTION 'eligible set grant episode is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.generation := GREATEST(NEW.generation, OLD.generation + 1);
  RETURN NEW;
END $$;
CREATE TRIGGER eligible_org_member_set_grant_episode BEFORE UPDATE
  ON access.eligible_org_member_set_grant FOR EACH ROW
  EXECUTE FUNCTION access.keep_eligible_org_member_set_grant_episode();

CREATE TABLE access.eligible_org_member_set_grant_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('grant', 'revoke')),
  grant_id uuid NOT NULL REFERENCES access.eligible_org_member_set_grant(id),
  issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
  result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER eligible_org_member_set_grant_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.eligible_org_member_set_grant_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_representation_record_mutation();

-- A direct selected effect has no representation or acting Agent. The history
-- pins the exact private eligibility episode while exposing none of it in Main.
ALTER TABLE access.membership_history
  ADD COLUMN selected_selector_id uuid REFERENCES access.eligible_org_member_set(id),
  ADD COLUMN selected_selector_version bigint,
  ADD COLUMN selected_grant_id uuid REFERENCES access.eligible_org_member_set_grant(id),
  ADD COLUMN selected_grant_generation bigint,
  ADD COLUMN selected_membership_id uuid REFERENCES access.private_membership(id),
  ADD COLUMN selected_membership_generation bigint,
  ADD CONSTRAINT selected_membership_history_proof CHECK (
    (selected_selector_id IS NULL AND selected_selector_version IS NULL
      AND selected_grant_id IS NULL AND selected_grant_generation IS NULL
      AND selected_membership_id IS NULL AND selected_membership_generation IS NULL)
    OR (acting_subject IS NULL AND representation_id IS NULL AND grant_id IS NULL
      AND selected_selector_id IS NOT NULL AND selected_selector_version = 1
      AND selected_grant_id IS NOT NULL AND selected_grant_generation >= 0
      AND selected_membership_id IS NOT NULL AND selected_membership_generation >= 1));

CREATE TABLE access.selected_org_membership_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('join', 'leave')),
  membership_id uuid NOT NULL REFERENCES access.membership(id),
  result_generation bigint NOT NULL CHECK (result_generation >= 1),
  result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
  selector_id uuid NOT NULL REFERENCES access.eligible_org_member_set(id),
  selector_version bigint NOT NULL CHECK (selector_version = 1),
  grant_id uuid NOT NULL REFERENCES access.eligible_org_member_set_grant(id),
  grant_generation bigint NOT NULL CHECK (grant_generation >= 0),
  private_membership_id uuid NOT NULL REFERENCES access.private_membership(id),
  private_membership_generation bigint NOT NULL CHECK (private_membership_generation >= 1),
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER selected_org_membership_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.selected_org_membership_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
