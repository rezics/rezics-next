-- Listing and newcomer history are independent of disclosure and membership.
ALTER TABLE access.realm_admin_settings
  ADD COLUMN listing text NOT NULL DEFAULT 'listed' CHECK (listing IN ('listed','unlisted')),
  ADD COLUMN history text NOT NULL DEFAULT 'everything' CHECK (history IN ('everything','from-admission'));
-- self_join continues to own open admission. This column distinguishes the two
-- managed admission paths; open remains the policy's lifecycle gate.
ALTER TABLE access.membership_policy
  ADD COLUMN admission text NOT NULL DEFAULT 'invitation' CHECK (admission IN ('request','invitation'));
ALTER TABLE access.realm_policy_delivery
  ADD COLUMN listing text NOT NULL DEFAULT 'listed' CHECK (listing IN ('listed','unlisted')),
  ADD COLUMN history text NOT NULL DEFAULT 'everything' CHECK (history IN ('everything','from-admission')),
  ADD COLUMN admission text NOT NULL DEFAULT 'invitation' CHECK (admission IN ('open','request','invitation'));

-- Every episode retains its admission cut, including joins while history is
-- everything. A later policy change never backfills a fabricated earlier cut.
CREATE TABLE access.realm_history_admission (
  kind text NOT NULL CHECK (kind IN ('agent','private')),
  membership_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  data_epoch text NOT NULL,
  sequence numeric NOT NULL CHECK (sequence >= 0 AND sequence = trunc(sequence)),
  PRIMARY KEY (kind,membership_id,generation)
);
CREATE TRIGGER realm_history_admission_immutable BEFORE UPDATE OR DELETE
  ON access.realm_history_admission FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE TABLE access.agent_listing (
  agent_id text PRIMARY KEY REFERENCES access.authority_subject(id),
  listing text NOT NULL CHECK (listing IN ('listed','unlisted')),
  version integer NOT NULL CHECK (version >= 1),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE access.agent_listing_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  agent_id text NOT NULL REFERENCES access.authority_subject(id),
  listing text NOT NULL CHECK (listing IN ('listed','unlisted')),
  version integer NOT NULL CHECK (version >= 1),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id,idempotency_key)
);
CREATE TRIGGER agent_listing_receipt_immutable BEFORE UPDATE OR DELETE
  ON access.agent_listing_receipt FOR EACH ROW
  EXECUTE FUNCTION access.reject_membership_record_mutation();
