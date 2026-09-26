-- GOV11/GOV15/GOV16/GOV18: a voting mandate is an ordinary Access representation
-- with action governance.ballot.operate. subject_id is the seat holder Agent and
-- resource_subject is the electorate body Agent. It carries no weight: Jena owns
-- charters, entitlements, allocations and ballots. Replacing a representative
-- issues a new mandate identity; an existing mandate episode can only be revoked.
ALTER TABLE access.representation_request DROP CONSTRAINT representation_request_profile;
ALTER TABLE access.representation_request ADD CONSTRAINT representation_request_profile CHECK (
  (action = 'work.create' AND resource_subject IS NULL)
  OR (action = 'access.membership.manage.org' AND resource_subject IS NOT NULL)
  OR (action = 'governance.ballot.operate' AND resource_subject IS NOT NULL));

ALTER TABLE access.representation ADD CONSTRAINT voting_mandate_resource CHECK (
  action <> 'governance.ballot.operate' OR resource_subject IS NOT NULL);
CREATE INDEX voting_mandate_holder_active ON access.representation
  (subject_id, resource_subject, principal_id, valid_until, id)
  WHERE active AND action = 'governance.ballot.operate';

CREATE FUNCTION access.keep_voting_mandate_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.action = 'governance.ballot.operate' OR NEW.action = 'governance.ballot.operate') AND
    ((NEW.id, NEW.principal_id, NEW.subject_id, NEW.action, NEW.valid_until,
        NEW.assigned_by_principal, NEW.request_id, NEW.resource_subject)
      IS DISTINCT FROM
      (OLD.id, OLD.principal_id, OLD.subject_id, OLD.action, OLD.valid_until,
        OLD.assigned_by_principal, OLD.request_id, OLD.resource_subject)
      OR (NOT OLD.active AND NEW.active)) THEN
    RAISE EXCEPTION 'voting mandate episode is immutable; only revoke is allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voting_mandate_episode BEFORE UPDATE ON access.representation
  FOR EACH ROW EXECUTE FUNCTION access.keep_voting_mandate_episode();

-- The holder's protected representative policy selects which current voting
-- mandates are designated, backup or k-of-n approvers under one exact Jena
-- holder-charter revision. The charter alone owns the mandate rule, threshold
-- and aggregation mode; this owner holds only the private operator selection.
CREATE TABLE access.vote_representative_policy (
  id uuid PRIMARY KEY,
  holder_subject text NOT NULL REFERENCES access.authority_subject(id),
  body_subject text NOT NULL REFERENCES access.authority_subject(id),
  head_revision bigint NOT NULL CHECK (head_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (holder_subject, body_subject)
);
CREATE INDEX vote_representative_policy_body_fk ON access.vote_representative_policy (body_subject);

CREATE TABLE access.vote_representative_policy_revision (
  policy_id uuid NOT NULL REFERENCES access.vote_representative_policy(id),
  revision bigint NOT NULL CHECK (revision >= 1),
  holder_charter_revision text NOT NULL
    CHECK (holder_charter_revision ~ '^https://rezics\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  holder_charter_digest text NOT NULL CHECK (holder_charter_digest ~ '^[0-9a-f]{64}$'),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (policy_id, revision)
);
ALTER TABLE access.vote_representative_policy ADD CONSTRAINT vote_representative_policy_head_fk
  FOREIGN KEY (id, head_revision)
  REFERENCES access.vote_representative_policy_revision(policy_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

-- Independence is by private principal (control identity), never by Agent or
-- persona count: one principal holds at most one role row per revision role.
CREATE TABLE access.vote_representative_policy_member (
  policy_id uuid NOT NULL,
  revision bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('designated', 'backup', 'approver')),
  representation_id uuid NOT NULL REFERENCES access.representation(id),
  representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  PRIMARY KEY (policy_id, revision, role, representation_id),
  UNIQUE (policy_id, revision, role, principal_id),
  FOREIGN KEY (policy_id, revision)
    REFERENCES access.vote_representative_policy_revision(policy_id, revision)
);
CREATE UNIQUE INDEX vote_policy_one_designated ON access.vote_representative_policy_member
  (policy_id, revision) WHERE role = 'designated';
CREATE INDEX vote_policy_member_representation ON access.vote_representative_policy_member
  (representation_id);
CREATE INDEX vote_policy_member_principal ON access.vote_representative_policy_member (principal_id);

-- A member must be an exact voting mandate of the same holder for the same body.
CREATE FUNCTION access.check_vote_policy_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM access.representation r
    JOIN access.vote_representative_policy p ON p.id = NEW.policy_id
    WHERE r.id = NEW.representation_id AND r.action = 'governance.ballot.operate' AND r.active
      AND r.subject_id = p.holder_subject AND r.resource_subject = p.body_subject
      AND r.principal_id = NEW.principal_id
      AND r.generation = NEW.representation_generation
  ) THEN
    RAISE EXCEPTION 'vote policy member requires the exact holder voting mandate' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vote_policy_member_mandate BEFORE INSERT ON access.vote_representative_policy_member
  FOR EACH ROW EXECUTE FUNCTION access.check_vote_policy_member();

CREATE TABLE access.vote_representative_policy_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  policy_id uuid NOT NULL,
  revision bigint NOT NULL,
  authority_proof jsonb NOT NULL CHECK (jsonb_typeof(authority_proof) = 'object'),
  result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, idempotency_key),
  FOREIGN KEY (policy_id, revision)
    REFERENCES access.vote_representative_policy_revision(policy_id, revision)
);
CREATE INDEX vote_policy_receipt_revision ON access.vote_representative_policy_receipt
  (policy_id, revision);

CREATE FUNCTION access.reject_vote_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable Access vote record' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER vote_policy_revision_immutable BEFORE UPDATE OR DELETE
  ON access.vote_representative_policy_revision FOR EACH ROW
  EXECUTE FUNCTION access.reject_vote_record_mutation();
CREATE TRIGGER vote_policy_member_immutable BEFORE UPDATE OR DELETE
  ON access.vote_representative_policy_member FOR EACH ROW
  EXECUTE FUNCTION access.reject_vote_record_mutation();
CREATE TRIGGER vote_policy_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.vote_representative_policy_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_vote_record_mutation();

-- The family row only advances its head; the pair never changes identity.
CREATE FUNCTION access.advance_vote_policy_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id, NEW.holder_subject, NEW.body_subject, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.holder_subject, OLD.body_subject, OLD.created_at)
      OR NEW.head_revision <> OLD.head_revision + 1 THEN
    RAISE EXCEPTION 'vote policy head advances by exactly one revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vote_policy_head_advance BEFORE UPDATE OR DELETE
  ON access.vote_representative_policy FOR EACH ROW
  EXECUTE FUNCTION access.advance_vote_policy_head();
