-- EvidenceSetRevision: one immutable, complete manifest of supporting,
-- contradicting and uncertain evidence for an exact claim revision. The claim's
-- own chain ('claim-head') advances one head by CAS; challenge and correction
-- proposal manifests are standalone and never move that head.
CREATE TABLE verification.evidence_set_revision (
  id uuid PRIMARY KEY,
  claim verification.rezics_id NOT NULL,
  claim_revision verification.rezics_id NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('claim-head', 'challenge', 'correction-proposal')),
  predecessor uuid,
  item_count smallint NOT NULL CHECK (item_count BETWEEN 0 AND 32),
  manifest_digest verification.sha256 NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (claim, id),
  UNIQUE (id, claim, purpose),
  CHECK (purpose = 'claim-head' OR predecessor IS NULL),
  FOREIGN KEY (claim, predecessor) REFERENCES verification.evidence_set_revision(claim, id)
);
-- One root and one successor per revision: the claim chain cannot fork.
CREATE UNIQUE INDEX evidence_chain_root ON verification.evidence_set_revision (claim)
  WHERE purpose = 'claim-head' AND predecessor IS NULL;
CREATE UNIQUE INDEX evidence_chain_successor ON verification.evidence_set_revision (claim, predecessor)
  WHERE purpose = 'claim-head' AND predecessor IS NOT NULL;
CREATE INDEX evidence_claim_history ON verification.evidence_set_revision (claim, created_at, id);
CREATE TRIGGER verification_evidence_revision_immutable BEFORE UPDATE OR DELETE
  ON verification.evidence_set_revision FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- Exactly one anchor per item: an immutable source observation, an exact
-- Content revision or an exact graph revision IRI. Availability is recorded as
-- observed; an inaccessible payload keeps its permitted anchor explicitly.
CREATE TABLE verification.evidence_item (
  revision_id uuid NOT NULL REFERENCES verification.evidence_set_revision(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  stance text NOT NULL CHECK (stance IN ('supports', 'contradicts', 'uncertain')),
  observation_id uuid REFERENCES source.observation(id),
  content_revision_id uuid REFERENCES content.revision(id),
  graph_reference verification.iri,
  selector jsonb NOT NULL CHECK (jsonb_typeof(selector) = 'object' AND octet_length(selector::text) <= 4096),
  availability text NOT NULL CHECK (availability IN ('available', 'inaccessible', 'withdrawn', 'erased')),
  PRIMARY KEY (revision_id, ordinal),
  CHECK (num_nonnulls(observation_id, content_revision_id, graph_reference) = 1)
);
CREATE UNIQUE INDEX evidence_item_identity ON verification.evidence_item (revision_id, stance,
  COALESCE(observation_id::text, content_revision_id::text, graph_reference), selector);
-- Reverse lookups for a withdrawn observation or erased Content revision.
CREATE INDEX evidence_item_observation ON verification.evidence_item (observation_id, revision_id)
  WHERE observation_id IS NOT NULL;
CREATE INDEX evidence_item_content_revision ON verification.evidence_item (content_revision_id, revision_id)
  WHERE content_revision_id IS NOT NULL;
CREATE TRIGGER verification_evidence_item_immutable BEFORE UPDATE OR DELETE
  ON verification.evidence_item FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

-- The claim evidence head. A missing row is the explicit null head; the first
-- revision inserts it, later revisions CAS it from their exact predecessor.
CREATE TABLE verification.evidence_head (
  claim verification.rezics_id PRIMARY KEY,
  head uuid NOT NULL,
  head_purpose text NOT NULL DEFAULT 'claim-head' CHECK (head_purpose = 'claim-head'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (head, claim, head_purpose)
    REFERENCES verification.evidence_set_revision(id, claim, purpose)
);

CREATE FUNCTION verification.guard_evidence_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence head cannot return to absence' USING ERRCODE = '23514';
  END IF;
  SELECT predecessor INTO predecessor_id FROM verification.evidence_set_revision WHERE id = NEW.head;
  IF TG_OP = 'INSERT' AND predecessor_id IS NOT NULL THEN
    RAISE EXCEPTION 'first evidence head must be a chain root'
      USING ERRCODE = '23514', CONSTRAINT = 'evidence_head_exact_predecessor';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.claim <> OLD.claim OR predecessor_id IS DISTINCT FROM OLD.head) THEN
    RAISE EXCEPTION 'evidence head successor differs from the current head'
      USING ERRCODE = '23514', CONSTRAINT = 'evidence_head_exact_predecessor';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_head_transition BEFORE INSERT OR UPDATE OR DELETE ON verification.evidence_head
  FOR EACH ROW EXECUTE FUNCTION verification.guard_evidence_head();

-- A manifest has exactly item_count ordered items at commit, and a claim-chain
-- revision is the head or already superseded; no orphan or prefix commits.
CREATE FUNCTION verification.check_evidence_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; expected smallint; chain_purpose text; claim_id text; actual bigint; highest smallint;
BEGIN
  IF TG_TABLE_NAME = 'evidence_set_revision' THEN target := NEW.id; ELSE target := NEW.revision_id; END IF;
  SELECT item_count, purpose, claim INTO expected, chain_purpose, claim_id
    FROM verification.evidence_set_revision WHERE id = target;
  SELECT count(*), max(ordinal) INTO actual, highest
    FROM verification.evidence_item WHERE revision_id = target;
  IF actual <> expected OR (expected > 0 AND highest <> expected - 1) THEN
    RAISE EXCEPTION 'evidence items differ from the complete manifest'
      USING ERRCODE = '23514', CONSTRAINT = 'evidence_complete_manifest';
  END IF;
  IF TG_TABLE_NAME = 'evidence_set_revision' AND chain_purpose = 'claim-head'
    AND NOT EXISTS (SELECT 1 FROM verification.evidence_head WHERE claim = claim_id AND head = target)
    AND NOT EXISTS (SELECT 1 FROM verification.evidence_set_revision
      WHERE claim = claim_id AND predecessor = target) THEN
    RAISE EXCEPTION 'claim evidence revision was not activated as the head'
      USING ERRCODE = '23514', CONSTRAINT = 'evidence_head_activated';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER evidence_complete_manifest AFTER INSERT ON verification.evidence_set_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verification.check_evidence_manifest();
CREATE CONSTRAINT TRIGGER evidence_item_complete_manifest AFTER INSERT ON verification.evidence_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verification.check_evidence_manifest();
