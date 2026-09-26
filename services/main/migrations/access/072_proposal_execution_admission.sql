-- GOV23: executing a finalized resolution is its own admitted command. The proof
-- binds the exact proposal revision, resolution, effect digest, target and
-- expected target state to two current Access facts: the executor's mandate to
-- act for the body, and the body's own capability grant for the effect action
-- on the target scope. Passing a proposal grants voters nothing; Jena's
-- execution record and the admission seal keep one effect per operation.
CREATE TABLE access.proposal_execution_admission (
  admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
  proposal text NOT NULL
    CHECK (proposal ~ '^https://rezics\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  proposal_revision text NOT NULL CHECK (proposal_revision ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  resolution text NOT NULL CHECK (resolution ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  body_subject text NOT NULL REFERENCES access.authority_subject(id),
  effect_digest text NOT NULL CHECK (effect_digest ~ '^[0-9a-f]{64}$'),
  effect_target text NOT NULL CHECK (effect_target ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  expected_target_state text NOT NULL CHECK (expected_target_state ~ '^[0-9a-f]{64}$'),
  capability text NOT NULL CHECK (capability ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'
    AND length(capability) <= 128 AND capability NOT LIKE 'governance.%'),
  capability_scope text NOT NULL REFERENCES access.scope_gate(id),
  capability_grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
  capability_grant_generation bigint NOT NULL CHECK (capability_grant_generation >= 0),
  representation_id uuid NOT NULL REFERENCES access.representation(id),
  representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
  principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
  body_generation bigint NOT NULL CHECK (body_generation >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX proposal_execution_effect ON access.proposal_execution_admission
  (proposal_revision, effect_digest, created_at, admission_id);
CREATE INDEX proposal_execution_grant_fk ON access.proposal_execution_admission (capability_grant_id);
CREATE INDEX proposal_execution_representation_fk ON access.proposal_execution_admission (representation_id);
CREATE INDEX proposal_execution_scope_fk ON access.proposal_execution_admission (capability_scope);
CREATE INDEX proposal_execution_body_fk ON access.proposal_execution_admission (body_subject);
CREATE TRIGGER proposal_execution_admission_immutable BEFORE UPDATE OR DELETE
  ON access.proposal_execution_admission FOR EACH ROW
  EXECUTE FUNCTION access.reject_vote_record_mutation();

CREATE FUNCTION access.check_proposal_execution_proof() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM access.admission a
    JOIN access.representation r ON r.id = NEW.representation_id
    JOIN access.permission_grant g ON g.id = NEW.capability_grant_id
    WHERE a.id = NEW.admission_id
      AND a.action = 'governance.proposal.execute'
      AND a.scope_id = 'governance:body:' || right(NEW.body_subject, 36)
      AND a.acting_subject = NEW.body_subject
      AND a.principal_id = r.principal_id
      AND r.subject_id = NEW.body_subject AND r.action = 'governance.proposal.execute'
      AND r.generation = NEW.representation_generation
      AND g.recipient_subject = NEW.body_subject AND g.scope_id = NEW.capability_scope
      AND g.action = NEW.capability AND g.generation = NEW.capability_grant_generation
  ) THEN
    RAISE EXCEPTION 'proposal execution proof must bind its exact admission, mandate and capability'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposal_execution_exact_proof BEFORE INSERT ON access.proposal_execution_admission
  FOR EACH ROW EXECUTE FUNCTION access.check_proposal_execution_proof();

CREATE FUNCTION access.require_proposal_execution_proof() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.proposal_execution_admission p WHERE p.admission_id = NEW.id) THEN
    RAISE EXCEPTION 'proposal execution admission requires exact atomic proof' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER proposal_execution_admission_bound
  AFTER INSERT OR UPDATE ON access.admission DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.action = 'governance.proposal.execute')
  EXECUTE FUNCTION access.require_proposal_execution_proof();
