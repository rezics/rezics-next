-- Editorial protection and reviewed correction of the Content-owned draft head
-- (profile content-draft-protection-v1). Jena keeps protection of graph adoptions;
-- this binding never constrains a publication selection or another variant.
-- The draft profile has no source-control dimension: no source writer advances a
-- draft head, and content.revision.source_revision stays provenance only.

-- Reuse the Content receipt; register its actions in the migration-022 registry.
INSERT INTO content.receipt_action (action) VALUES
  ('protection.change'), ('correction.propose'), ('correction.decide')
  ON CONFLICT DO NOTHING;

-- At most 32 distinct exact evidence references, never a truncated list.
CREATE FUNCTION content.exact_references(refs jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs) > 32 THEN false
    ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(refs) item
      WHERE jsonb_typeof(item) <> 'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 300)
      AND (SELECT count(DISTINCT item) FROM jsonb_array_elements(refs) item) = jsonb_array_length(refs) END
$$;

CREATE TABLE content.protection_revision (
  id uuid PRIMARY KEY,
  variant_id text NOT NULL REFERENCES content.variant(id),
  predecessor uuid,
  epoch bigint NOT NULL CHECK (epoch >= 1),
  profile text NOT NULL CHECK (profile = 'content-draft-protection-v1'),
  action text NOT NULL CHECK (action IN ('tighten', 'confirm', 'relax')),
  mode text NOT NULL CHECK (mode IN ('open', 'review-required')),
  rule_revision text NOT NULL CHECK (rule_revision = 'urn:rezics:protection-rule:independent-human-review-v1'),
  -- Content head at activation: historical evidence, not a requirement that content stays equal.
  observed_head uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  evidence jsonb NOT NULL CHECK (content.exact_references(evidence)),
  agent text CHECK (length(agent) BETWEEN 1 AND 300),
  operation_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, id),
  UNIQUE (variant_id, epoch),
  FOREIGN KEY (variant_id, predecessor) REFERENCES content.protection_revision(variant_id, id),
  FOREIGN KEY (variant_id, observed_head) REFERENCES content.revision(variant_id, id),
  FOREIGN KEY (operation_id) REFERENCES content.receipt(operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((predecessor IS NULL) = (epoch = 1)),
  CHECK ((action = 'relax') = (mode = 'open'))
);

-- NULL is the profile's explicit absent protection head (effective open). Restore
-- holds, not this default, cover unknown or partially restored state.
ALTER TABLE content.variant ADD COLUMN protection_head uuid;
ALTER TABLE content.variant ADD CONSTRAINT variant_protection_head_fk
  FOREIGN KEY (id, protection_head) REFERENCES content.protection_revision(variant_id, id);

CREATE TABLE content.correction_proposal (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number >= 1),
  predecessor uuid,
  variant_id text NOT NULL REFERENCES content.variant(id),
  profile text NOT NULL CHECK (profile = 'content-draft-protection-v1'),
  base_head uuid NOT NULL,
  -- NULL asserts the absent protection head at proposal time.
  base_protection uuid,
  rule_revision text NOT NULL CHECK (rule_revision = 'urn:rezics:protection-rule:independent-human-review-v1'),
  candidate_revision uuid NOT NULL,
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL CHECK (content.exact_references(evidence)),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  agent text CHECK (length(agent) BETWEEN 1 AND 300),
  operation_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, id),
  UNIQUE (proposal_id, revision_number),
  UNIQUE (id, variant_id, base_head, candidate_revision, candidate_digest, rule_revision),
  FOREIGN KEY (proposal_id, predecessor) REFERENCES content.correction_proposal(proposal_id, id),
  FOREIGN KEY (variant_id, base_head) REFERENCES content.revision(variant_id, id),
  FOREIGN KEY (variant_id, base_protection) REFERENCES content.protection_revision(variant_id, id),
  FOREIGN KEY (variant_id, candidate_revision) REFERENCES content.revision(variant_id, id),
  FOREIGN KEY (operation_id) REFERENCES content.receipt(operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((predecessor IS NULL) = (revision_number = 1)),
  CHECK (candidate_revision <> base_head)
);
CREATE INDEX correction_proposal_target_idx ON content.correction_proposal (variant_id, created_at DESC, id DESC);

CREATE TABLE content.correction_decision (
  id uuid PRIMARY KEY,
  -- One terminal decision per proposal revision; a changed proposal needs a new revision.
  proposal_revision uuid NOT NULL UNIQUE,
  variant_id text NOT NULL,
  base_head uuid NOT NULL,
  candidate_revision uuid NOT NULL,
  candidate_digest text NOT NULL,
  rule_revision text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  -- Opaque Access proof reference; private principal and control identities stay in Access.
  independence_proof text CHECK (length(independence_proof) BETWEEN 1 AND 300),
  evidence jsonb NOT NULL CHECK (content.exact_references(evidence)),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  agent text CHECK (length(agent) BETWEEN 1 AND 300),
  operation_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, proposal_revision, outcome, operation_id),
  FOREIGN KEY (proposal_revision, variant_id, base_head, candidate_revision, candidate_digest, rule_revision)
    REFERENCES content.correction_proposal(id, variant_id, base_head, candidate_revision, candidate_digest, rule_revision),
  FOREIGN KEY (operation_id) REFERENCES content.receipt(operation_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (outcome = 'rejected' OR independence_proof IS NOT NULL)
);

CREATE TABLE content.correction_application (
  -- A new request key cannot apply the same proposal revision twice.
  proposal_revision uuid PRIMARY KEY,
  decision_id uuid NOT NULL UNIQUE,
  decision_outcome text NOT NULL DEFAULT 'approved' CHECK (decision_outcome = 'approved'),
  variant_id text NOT NULL,
  base_head uuid NOT NULL,
  successor_head uuid NOT NULL,
  candidate_digest text NOT NULL,
  rule_revision text NOT NULL,
  -- Effective protection preserved by the application; NULL is the absent head.
  protection_head uuid,
  operation_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, base_head),
  FOREIGN KEY (decision_id, proposal_revision, decision_outcome, operation_id)
    REFERENCES content.correction_decision(id, proposal_revision, outcome, operation_id),
  FOREIGN KEY (proposal_revision, variant_id, base_head, successor_head, candidate_digest, rule_revision)
    REFERENCES content.correction_proposal(id, variant_id, base_head, candidate_revision, candidate_digest, rule_revision),
  FOREIGN KEY (variant_id, protection_head) REFERENCES content.protection_revision(variant_id, id),
  FOREIGN KEY (operation_id) REFERENCES content.receipt(operation_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER protection_revision_immutable BEFORE UPDATE OR DELETE ON content.protection_revision
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE TRIGGER correction_proposal_immutable BEFORE UPDATE OR DELETE ON content.correction_proposal
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE TRIGGER correction_decision_immutable BEFORE UPDATE OR DELETE ON content.correction_decision
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE TRIGGER correction_application_immutable BEFORE UPDATE OR DELETE ON content.correction_application
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();

-- Every writer, including the pre-protection draft.save path, serializes on the
-- existing variant row. The optional protection row alone cannot be locked.
CREATE FUNCTION content.variant_protection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.protection_head IS DISTINCT FROM OLD.protection_head AND (NEW.protection_head IS NULL
    OR NOT EXISTS (SELECT 1 FROM content.protection_revision p WHERE p.id = NEW.protection_head
      AND p.variant_id = NEW.id AND p.predecessor IS NOT DISTINCT FROM OLD.protection_head)) THEN
    RAISE EXCEPTION 'protection head advances only to its appended successor'
      USING ERRCODE = '23514', CONSTRAINT = 'variant_protection_append_only';
  END IF;
  IF NEW.draft_head IS DISTINCT FROM OLD.draft_head
    AND EXISTS (SELECT 1 FROM content.protection_revision p
      WHERE p.id = OLD.protection_head AND p.mode = 'review-required')
    AND NOT EXISTS (SELECT 1 FROM content.correction_application a WHERE a.variant_id = NEW.id
      AND a.base_head = OLD.draft_head AND a.successor_head = NEW.draft_head
      AND a.protection_head IS NOT DISTINCT FROM OLD.protection_head) THEN
    RAISE EXCEPTION 'review-required draft head changes only through a reviewed correction'
      USING ERRCODE = '23514', CONSTRAINT = 'variant_correction_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER variant_protection_guard BEFORE UPDATE ON content.variant
  FOR EACH ROW EXECUTE FUNCTION content.variant_protection_guard();

CREATE FUNCTION content.append_protection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record; prior_epoch bigint := 0; prior_mode text := 'open';
BEGIN
  SELECT draft_head, protection_head INTO target FROM content.variant WHERE id = NEW.variant_id FOR UPDATE;
  IF NOT FOUND OR target.protection_head IS DISTINCT FROM NEW.predecessor THEN
    RAISE EXCEPTION 'protection basis is stale' USING ERRCODE = '23514', CONSTRAINT = 'protection_stale_basis';
  END IF;
  IF target.draft_head IS DISTINCT FROM NEW.observed_head THEN
    RAISE EXCEPTION 'protection content basis is stale' USING ERRCODE = '23514', CONSTRAINT = 'protection_stale_content';
  END IF;
  IF NEW.predecessor IS NOT NULL THEN
    SELECT epoch, mode INTO prior_epoch, prior_mode FROM content.protection_revision WHERE id = NEW.predecessor;
  END IF;
  -- Absent protection is the profile's open default. Confirm re-binds acceptance at any mode.
  IF NEW.epoch IS DISTINCT FROM prior_epoch + 1 OR (NEW.action = 'tighten' AND prior_mode IS DISTINCT FROM 'open')
    OR (NEW.action = 'relax' AND prior_mode IS DISTINCT FROM 'review-required') THEN
    RAISE EXCEPTION 'protection transition is not admitted' USING ERRCODE = '23514', CONSTRAINT = 'protection_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protection_revision_append BEFORE INSERT ON content.protection_revision
  FOR EACH ROW EXECUTE FUNCTION content.append_protection_revision();

CREATE FUNCTION content.activate_protection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE content.variant SET protection_head = NEW.id WHERE id = NEW.variant_id;
  RETURN NULL;
END $$;
CREATE TRIGGER protection_revision_activate AFTER INSERT ON content.protection_revision
  FOR EACH ROW EXECUTE FUNCTION content.activate_protection_revision();

CREATE FUNCTION content.record_correction_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record; candidate record; prior record;
BEGIN
  SELECT draft_head, protection_head INTO target FROM content.variant WHERE id = NEW.variant_id FOR UPDATE;
  IF NOT FOUND OR target.draft_head IS DISTINCT FROM NEW.base_head
    OR target.protection_head IS DISTINCT FROM NEW.base_protection THEN
    RAISE EXCEPTION 'correction basis is stale' USING ERRCODE = '23514', CONSTRAINT = 'correction_stale_basis';
  END IF;
  SELECT predecessor, byte_digest, availability INTO candidate FROM content.revision WHERE id = NEW.candidate_revision;
  IF candidate.predecessor IS DISTINCT FROM NEW.base_head OR candidate.byte_digest <> NEW.candidate_digest
    OR candidate.availability <> 'available' THEN
    RAISE EXCEPTION 'correction candidate differs from its base' USING ERRCODE = '23514', CONSTRAINT = 'correction_candidate';
  END IF;
  IF NEW.predecessor IS NOT NULL THEN
    SELECT variant_id, revision_number INTO prior FROM content.correction_proposal WHERE id = NEW.predecessor;
    -- An applied correction is reversed by a new correction, never by revising it.
    IF prior.variant_id IS DISTINCT FROM NEW.variant_id OR NEW.revision_number IS DISTINCT FROM prior.revision_number + 1
      OR EXISTS (SELECT 1 FROM content.correction_application WHERE proposal_revision = NEW.predecessor) THEN
      RAISE EXCEPTION 'correction revision is not admitted' USING ERRCODE = '23514', CONSTRAINT = 'correction_revision';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER correction_proposal_record BEFORE INSERT ON content.correction_proposal
  FOR EACH ROW EXECUTE FUNCTION content.record_correction_proposal();

CREATE FUNCTION content.record_correction_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Decisions serialize with edits and protection changes of the same target.
  PERFORM 1 FROM content.variant WHERE id = NEW.variant_id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER correction_decision_record BEFORE INSERT ON content.correction_decision
  FOR EACH ROW EXECUTE FUNCTION content.record_correction_decision();

-- The first bounded profile commits approval and application together.
CREATE FUNCTION content.require_correction_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'approved' AND NOT EXISTS (
    SELECT 1 FROM content.correction_application WHERE decision_id = NEW.id) THEN
    RAISE EXCEPTION 'approval requires its application in the same commit'
      USING ERRCODE = '23514', CONSTRAINT = 'correction_approval_applied';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER correction_decision_applied AFTER INSERT ON content.correction_decision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content.require_correction_application();

CREATE FUNCTION content.apply_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record; proposal record; available text;
BEGIN
  SELECT draft_head, protection_head INTO target FROM content.variant WHERE id = NEW.variant_id FOR UPDATE;
  SELECT base_protection INTO proposal FROM content.correction_proposal WHERE id = NEW.proposal_revision;
  IF NOT FOUND OR target.draft_head IS DISTINCT FROM NEW.base_head
    OR target.protection_head IS DISTINCT FROM NEW.protection_head
    OR proposal.base_protection IS DISTINCT FROM target.protection_head THEN
    RAISE EXCEPTION 'correction basis is stale' USING ERRCODE = '23514', CONSTRAINT = 'correction_stale_basis';
  END IF;
  SELECT availability INTO available FROM content.revision WHERE id = NEW.successor_head;
  IF available IS DISTINCT FROM 'available' THEN
    RAISE EXCEPTION 'correction candidate is unavailable' USING ERRCODE = '23514', CONSTRAINT = 'correction_candidate';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER correction_application_apply BEFORE INSERT ON content.correction_application
  FOR EACH ROW EXECUTE FUNCTION content.apply_correction();

CREATE FUNCTION content.advance_corrected_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE content.variant SET draft_head = NEW.successor_head WHERE id = NEW.variant_id;
  RETURN NULL;
END $$;
CREATE TRIGGER correction_application_advance AFTER INSERT ON content.correction_application
  FOR EACH ROW EXECUTE FUNCTION content.advance_corrected_head();
