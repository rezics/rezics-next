-- A named, closed permission source, pinned to each admission. Person ownership
-- comes from a completed provision and its exact still-active control mandate;
-- delegated control, Organizations and Service Agents do not imply membership.
CREATE TABLE access.baseline_member_policy (
    id text PRIMARY KEY CHECK (id = 'baseline-member-v1'),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
INSERT INTO access.baseline_member_policy (id) VALUES ('baseline-member-v1');
CREATE FUNCTION access.guard_baseline_member_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.id <> OLD.id OR NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'baseline policy changes must advance the generation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER baseline_member_policy_guard BEFORE UPDATE OR DELETE ON access.baseline_member_policy
    FOR EACH ROW EXECUTE FUNCTION access.guard_baseline_member_policy();

CREATE TABLE access.baseline_admission (
    admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
    policy_id text NOT NULL REFERENCES access.baseline_member_policy(id),
    policy_generation bigint NOT NULL CHECK (policy_generation >= 0),
    provision_id uuid NOT NULL REFERENCES access.agent_provision(id),
    representation_id uuid NOT NULL REFERENCES access.representation(id),
    representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
    subject_generation bigint NOT NULL CHECK (subject_generation >= 0),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    collection_create boolean NOT NULL DEFAULT false,
    related_work text CHECK (related_work ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    source_revision uuid
);
CREATE INDEX baseline_admission_provision ON access.baseline_admission (provision_id);
CREATE INDEX baseline_admission_representation ON access.baseline_admission (representation_id);
CREATE INDEX baseline_admission_policy ON access.baseline_admission (policy_id);
CREATE FUNCTION access.reject_baseline_proof_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'baseline admission proof is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER baseline_admission_immutable BEFORE UPDATE OR DELETE ON access.baseline_admission
    FOR EACH ROW EXECUTE FUNCTION access.reject_baseline_proof_mutation();

-- Bounded acting-context discovery is independent of every other account's
-- Agents and this account's abandoned or pending provision history.
CREATE INDEX agent_provision_baseline_candidates ON access.agent_provision (principal_id, agent_id)
    WHERE state = 'active' AND agent_kind = 'person';

INSERT INTO access.scope_gate (id) VALUES ('work:create:root'), ('space:create:root')
    ON CONFLICT (id) DO NOTHING;

-- Existing per-target scopes use the same bounded on-demand derivation as new
-- targets: one INSERT ON CONFLICT per authorized command, never a corpus scan.
-- No migration reopens an operator-closed gate.
