-- IAM26 binds the requested mandate and the selected grant to one Org roster.
-- A work.create request remains exactly the old, resource-less profile.
ALTER TABLE access.representation_request
  DROP CONSTRAINT representation_request_action_check;
ALTER TABLE access.representation_request
  ADD COLUMN resource_subject text REFERENCES access.authority_subject(id),
  ADD CONSTRAINT representation_request_profile CHECK (
    (action = 'work.create' AND resource_subject IS NULL)
    OR (action = 'access.membership.manage.org' AND resource_subject IS NOT NULL));
ALTER TABLE access.representation
  ADD COLUMN resource_subject text REFERENCES access.authority_subject(id),
  ADD COLUMN private_membership_id uuid REFERENCES access.private_membership(id),
  ADD COLUMN private_membership_generation bigint,
  ADD COLUMN represented_principal_epoch bigint,
  ADD COLUMN represented_subject_generation bigint,
  ADD COLUMN represented_resource_generation bigint,
  ADD CONSTRAINT represented_org_mandate_resource CHECK (
    ((request_id IS NULL OR action <> 'access.membership.manage.org')
      OR (resource_subject IS NOT NULL AND private_membership_id IS NOT NULL
        AND private_membership_generation >= 1
        AND represented_principal_epoch IS NOT NULL AND represented_principal_epoch >= 0
        AND represented_subject_generation IS NOT NULL AND represented_subject_generation >= 0
        AND represented_resource_generation IS NOT NULL AND represented_resource_generation >= 0))
    AND ((private_membership_id IS NULL AND private_membership_generation IS NULL)
      OR (action = 'access.membership.manage.org' AND request_id IS NOT NULL
        AND resource_subject IS NOT NULL AND private_membership_id IS NOT NULL
        AND private_membership_generation >= 1)));

ALTER TABLE access.permission_grant
  ADD COLUMN represented_issuer_generation bigint,
  ADD COLUMN represented_recipient_generation bigint,
  ADD CONSTRAINT represented_org_grant_generations CHECK (
    (action <> 'access.membership.manage.org'
      OR scope_id NOT LIKE 'access:org-roster:%')
    OR (represented_issuer_generation IS NOT NULL AND represented_issuer_generation >= 0
      AND represented_recipient_generation IS NOT NULL AND represented_recipient_generation >= 0));

-- The accepted request and issued grant define one authority episode. A later
-- update may revoke it, but cannot rebind its proof or restore it as a new one.
CREATE FUNCTION access.keep_represented_org_authority_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'representation' THEN
    IF OLD.request_id IS NOT NULL AND OLD.action = 'access.membership.manage.org' AND
      ((NEW.id, NEW.principal_id, NEW.subject_id, NEW.action, NEW.valid_until,
          NEW.assigned_by_principal, NEW.request_id, NEW.resource_subject,
          NEW.private_membership_id, NEW.private_membership_generation,
          NEW.represented_principal_epoch, NEW.represented_subject_generation,
          NEW.represented_resource_generation)
        IS DISTINCT FROM
        (OLD.id, OLD.principal_id, OLD.subject_id, OLD.action, OLD.valid_until,
          OLD.assigned_by_principal, OLD.request_id, OLD.resource_subject,
          OLD.private_membership_id, OLD.private_membership_generation,
          OLD.represented_principal_epoch, OLD.represented_subject_generation,
          OLD.represented_resource_generation)
        OR (NOT OLD.active AND NEW.active)) THEN
      RAISE EXCEPTION 'represented mandate episode is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.action = 'access.membership.manage.org'
      AND OLD.scope_id LIKE 'access:org-roster:%' AND
      ((NEW.id, NEW.issuer_subject, NEW.recipient_subject, NEW.scope_id,
          NEW.action, NEW.valid_until, NEW.assigned_by_principal,
          NEW.membership_id, NEW.membership_generation,
          NEW.represented_issuer_generation, NEW.represented_recipient_generation)
        IS DISTINCT FROM
        (OLD.id, OLD.issuer_subject, OLD.recipient_subject, OLD.scope_id,
          OLD.action, OLD.valid_until, OLD.assigned_by_principal,
          OLD.membership_id, OLD.membership_generation,
          OLD.represented_issuer_generation, OLD.represented_recipient_generation)
        OR (NOT OLD.active AND NEW.active)) THEN
    RAISE EXCEPTION 'represented grant episode is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER represented_org_mandate_episode BEFORE UPDATE ON access.representation
  FOR EACH ROW EXECUTE FUNCTION access.keep_represented_org_authority_episode();
CREATE TRIGGER represented_org_grant_episode BEFORE UPDATE ON access.permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.keep_represented_org_authority_episode();

-- IAM25's personal grant remains a separate eligibility source; admitting the
-- exact action here does not make it usable through an A representation.
ALTER TABLE access.principal_permission_grant
  DROP CONSTRAINT principal_permission_grant_action_check;
ALTER TABLE access.principal_permission_grant
  ADD CONSTRAINT principal_permission_grant_action_check
    CHECK (action IN ('work.create', 'access.membership.manage.org'));

-- This indexed owner binding makes a grant on some other scope unusable for B.
CREATE TABLE access.org_roster_scope (
  owner_subject text PRIMARY KEY REFERENCES access.authority_subject(id),
  scope_id text NOT NULL UNIQUE REFERENCES access.scope_gate(id),
  CHECK (scope_id = 'access:org-roster:' || right(owner_subject, 36))
);
CREATE TRIGGER org_roster_scope_immutable
  BEFORE UPDATE OR DELETE ON access.org_roster_scope
  FOR EACH ROW EXECUTE FUNCTION access.reject_representation_record_mutation();

ALTER TABLE access.membership_history
  ADD COLUMN acting_subject text REFERENCES access.authority_subject(id),
  ADD COLUMN representation_id uuid REFERENCES access.representation(id),
  ADD COLUMN representation_generation bigint,
  ADD COLUMN grant_id uuid REFERENCES access.permission_grant(id),
  ADD COLUMN grant_generation bigint,
  ADD CONSTRAINT represented_membership_history_proof CHECK (
    (acting_subject IS NULL AND representation_id IS NULL
      AND representation_generation IS NULL AND grant_id IS NULL AND grant_generation IS NULL)
    OR (acting_subject IS NOT NULL AND representation_id IS NOT NULL
      AND representation_generation IS NOT NULL AND grant_id IS NOT NULL
      AND grant_generation IS NOT NULL));
ALTER TABLE access.membership_change_receipt
  ADD COLUMN acting_subject text REFERENCES access.authority_subject(id),
  ADD COLUMN representation_id uuid REFERENCES access.representation(id),
  ADD COLUMN representation_generation bigint,
  ADD COLUMN grant_id uuid REFERENCES access.permission_grant(id),
  ADD COLUMN grant_generation bigint,
  ADD CONSTRAINT represented_membership_receipt_proof CHECK (
    (acting_subject IS NULL AND representation_id IS NULL
      AND representation_generation IS NULL AND grant_id IS NULL AND grant_generation IS NULL)
    OR (acting_subject IS NOT NULL AND representation_id IS NOT NULL
      AND representation_generation IS NOT NULL AND grant_id IS NOT NULL
      AND grant_generation IS NOT NULL));

-- Both acceptance and B-to-A grant mutations have immutable, private operator
-- receipts. The selected resource/action are checked again on every new effect.
CREATE TABLE access.represented_membership_authority_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('accept', 'revoke-mandate', 'grant', 'revoke-grant')),
  object_id uuid NOT NULL,
  issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
  resource_subject text NOT NULL REFERENCES access.authority_subject(id),
  result_authority_epoch bigint NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER represented_membership_authority_receipt_immutable
  BEFORE UPDATE OR DELETE ON access.represented_membership_authority_receipt
  FOR EACH ROW EXECUTE FUNCTION access.reject_representation_record_mutation();
