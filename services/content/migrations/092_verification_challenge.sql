-- A challenge records a precise target, reason and counterevidence as pending
-- review. It is never itself a disputed/false verdict; a separate qualified
-- assessment (assessment-v1) may establish material conflict. Funding or
-- subscription state has no column here and cannot alter the outcome.
CREATE TABLE verification.challenge (
  id uuid PRIMARY KEY,
  claim verification.rezics_id NOT NULL,
  claim_revision verification.rezics_id NOT NULL,
  adopted_revision verification.iri,
  context verification.iri NOT NULL,
  reason verification.note NOT NULL,
  counterevidence uuid,
  counterevidence_purpose text NOT NULL DEFAULT 'challenge' CHECK (counterevidence_purpose = 'challenge'),
  acting_subject verification.rezics_id NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (counterevidence, claim, counterevidence_purpose)
    REFERENCES verification.evidence_set_revision(id, claim, purpose)
);
CREATE INDEX challenge_claim_history ON verification.challenge (claim, created_at, id);
CREATE INDEX challenge_counterevidence ON verification.challenge (counterevidence)
  WHERE counterevidence IS NOT NULL;
CREATE TRIGGER verification_challenge_immutable BEFORE UPDATE OR DELETE ON verification.challenge
  FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- Resolution appends one decision; the challenge and its disagreement remain.
-- Only the submitter may withdraw, and the submitter can never decide otherwise.
CREATE TABLE verification.challenge_resolution (
  challenge_id uuid PRIMARY KEY REFERENCES verification.challenge(id),
  outcome text NOT NULL CHECK (outcome IN ('material-conflict', 'not-established', 'superseded', 'withdrawn')),
  assessment verification.rezics_id,
  reason verification.note NOT NULL,
  acting_subject verification.rezics_id NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome IN ('material-conflict', 'not-established')) = (assessment IS NOT NULL))
);
CREATE INDEX challenge_resolution_assessment ON verification.challenge_resolution (assessment)
  WHERE assessment IS NOT NULL;
CREATE TRIGGER verification_challenge_resolution_immutable BEFORE UPDATE OR DELETE
  ON verification.challenge_resolution FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- Bounded review queue, maintained as source.native_work_title_pending is.
CREATE TABLE verification.challenge_pending (
  challenge_id uuid PRIMARY KEY REFERENCES verification.challenge(id),
  claim verification.rezics_id NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX challenge_pending_queue ON verification.challenge_pending (created_at, challenge_id);
CREATE INDEX challenge_pending_claim ON verification.challenge_pending (claim, challenge_id);

-- Per-claim challenge head: summaries pin `revision` as an exact dependency,
-- so a new or resolved challenge makes an older summary provably stale.
CREATE TABLE verification.challenge_head (
  claim verification.rezics_id PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  open_count integer NOT NULL CHECK (open_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION verification.open_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO verification.challenge_pending (challenge_id, claim, created_at)
    VALUES (NEW.id, NEW.claim, NEW.created_at);
  INSERT INTO verification.challenge_head (claim, revision, open_count) VALUES (NEW.claim, 1, 1)
    ON CONFLICT (claim) DO UPDATE SET revision = challenge_head.revision + 1,
      open_count = challenge_head.open_count + 1, updated_at = clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_open AFTER INSERT ON verification.challenge
  FOR EACH ROW EXECUTE FUNCTION verification.open_challenge();

CREATE FUNCTION verification.resolve_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submitter uuid; claim_id text;
BEGIN
  SELECT c.principal_id, c.claim INTO submitter, claim_id FROM verification.challenge c
    JOIN verification.challenge_pending p ON p.challenge_id = c.id
    WHERE c.id = NEW.challenge_id FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'challenge is not pending' USING ERRCODE = '23514', CONSTRAINT = 'challenge_pending_once';
  END IF;
  IF (NEW.outcome = 'withdrawn') <> (NEW.principal_id = submitter) THEN
    RAISE EXCEPTION 'a submitter may only withdraw; resolution needs an independent decider'
      USING ERRCODE = '23514', CONSTRAINT = 'challenge_independent_resolution';
  END IF;
  DELETE FROM verification.challenge_pending WHERE challenge_id = NEW.challenge_id;
  UPDATE verification.challenge_head SET revision = revision + 1, open_count = open_count - 1,
    updated_at = clock_timestamp() WHERE claim = claim_id;
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_resolve BEFORE INSERT ON verification.challenge_resolution
  FOR EACH ROW EXECUTE FUNCTION verification.resolve_challenge();
