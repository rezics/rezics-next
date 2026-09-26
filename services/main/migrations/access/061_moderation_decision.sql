-- One attributable moderation decision model. The existing organization
-- publication rejection (027) is its first kind: 027 stays that kind's exact
-- authority proof and dispatch admission, and every 027 row has exactly one
-- decision row with the same id. Later kinds bind a governance case, rule and
-- evidence revisions and an explicit target scope. Decisions are immutable;
-- reversal and restoration are new decisions.
CREATE TABLE access.moderation_decision (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN
        ('organization_publication_rejection', 'content_moderation', 'rights_disposition')),
    outcome text NOT NULL CHECK (outcome IN
        ('reject', 'restrict', 'interim_restrict', 'final_restrict', 'dismiss', 'restore', 'reverse')),
    context text NOT NULL CHECK (context = 'urn:rezics:context:global'
        OR context ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
    case_id uuid REFERENCES access.governance_case(id),
    case_sequence bigint CHECK (case_sequence >= 1),
    reverses_decision_id uuid UNIQUE,
    -- Graph-dispatched effects reuse the existing admission claim/seal receipt.
    admission_id uuid UNIQUE REFERENCES access.admission(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    authority_kind text NOT NULL CHECK (authority_kind IN ('platform', 'realm', 'resource_owner')),
    authority_scope_id text NOT NULL REFERENCES access.scope_gate(id),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    authority_proof_digest text NOT NULL CHECK (authority_proof_digest ~ '^[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    rule_ref text CHECK (rule_ref IS NULL OR length(rule_ref) BETWEEN 1 AND 512),
    rule_revision text CHECK (rule_revision IS NULL OR length(rule_revision) BETWEEN 1 AND 512),
    rule_digest text CHECK (rule_digest IS NULL OR rule_digest ~ '^[0-9a-f]{64}$'),
    evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
    rationale text CHECK (rationale IS NULL OR length(rationale) BETWEEN 1 AND 8000),
    disclosure text NOT NULL CHECK (disclosure IN ('private', 'parties', 'public_summary')),
    decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (principal_id, kind, idempotency_key),
    UNIQUE (case_id, case_sequence),
    UNIQUE (case_id, id),
    FOREIGN KEY (case_id, reverses_decision_id) REFERENCES access.moderation_decision(case_id, id),
    CHECK ((case_id IS NULL) = (case_sequence IS NULL)),
    CHECK ((kind = 'organization_publication_rejection') = (case_id IS NULL)),
    CHECK (kind <> 'organization_publication_rejection'
        OR (outcome = 'reject' AND admission_id IS NOT NULL AND authority_kind = 'realm')),
    CHECK (kind <> 'content_moderation' OR outcome IN ('restrict', 'dismiss', 'restore', 'reverse')),
    CHECK (kind <> 'rights_disposition'
        OR outcome IN ('interim_restrict', 'final_restrict', 'dismiss', 'restore', 'reverse')),
    CHECK ((outcome = 'reverse') = (reverses_decision_id IS NOT NULL)),
    -- Case decisions bind the exact rule and reviewed evidence revisions.
    CHECK (case_id IS NULL OR (rule_ref IS NOT NULL AND rule_revision IS NOT NULL
        AND rule_digest IS NOT NULL AND evidence_digest IS NOT NULL))
);
CREATE INDEX moderation_decision_scope_page ON access.moderation_decision (authority_scope_id, decided_at, id);
CREATE INDEX moderation_decision_acting_subject_fk ON access.moderation_decision (acting_subject);
CREATE TRIGGER moderation_decision_immutable BEFORE UPDATE OR DELETE ON access.moderation_decision
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();

-- The case row is the bounded CAS head: writers lock it, compare generation,
-- insert case_sequence = generation + 1 and advance both columns.
ALTER TABLE access.governance_case
    ADD COLUMN decision_head uuid,
    ADD CONSTRAINT governance_case_decision_head_fk FOREIGN KEY (id, decision_head)
        REFERENCES access.moderation_decision(case_id, id),
    ADD CONSTRAINT governance_case_head_generation CHECK ((decision_head IS NULL) = (generation = 0));

CREATE FUNCTION access.guard_governance_case() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'governance case cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.generation <> 0 OR NEW.decision_head IS NOT NULL OR NEW.state <> 'open' THEN
            RAISE EXCEPTION 'governance case starts open without decisions' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.authority_kind <> OLD.authority_kind
        OR NEW.authority_scope_id <> OLD.authority_scope_id OR NEW.context <> OLD.context
        OR NEW.target_owner <> OLD.target_owner OR NEW.target_resource <> OLD.target_resource
        OR NEW.target_component <> OLD.target_component OR NEW.opened_at <> OLD.opened_at
        OR (OLD.state = 'closed' AND NEW.state = 'open') THEN
        RAISE EXCEPTION 'governance case identity is immutable and closure is final' USING ERRCODE = '23514';
    END IF;
    IF NEW.decision_head IS DISTINCT FROM OLD.decision_head OR NEW.generation <> OLD.generation THEN
        IF NEW.generation <> OLD.generation + 1 OR NOT EXISTS (
            SELECT 1 FROM access.moderation_decision d
            WHERE d.id = NEW.decision_head AND d.case_id = NEW.id AND d.case_sequence = NEW.generation) THEN
            RAISE EXCEPTION 'governance case head must advance to its next decision' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER governance_case_guard BEFORE INSERT OR UPDATE OR DELETE ON access.governance_case
    FOR EACH ROW EXECUTE FUNCTION access.guard_governance_case();

-- A case decision takes exactly the next sequence of its locked case head.
CREATE FUNCTION access.require_next_case_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.case_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM access.governance_case c
        WHERE c.id = NEW.case_id AND c.state = 'open' AND c.generation + 1 = NEW.case_sequence
          AND c.authority_scope_id = NEW.authority_scope_id AND c.context = NEW.context
          AND ((c.kind = 'rights_complaint') = (NEW.kind = 'rights_disposition'))) THEN
        RAISE EXCEPTION 'case decision is stale or outside its case scope' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER moderation_decision_next_case_sequence BEFORE INSERT ON access.moderation_decision
    FOR EACH ROW EXECUTE FUNCTION access.require_next_case_decision();

-- Explicit decision scope. An exact-revision target never condemns a later
-- revision; a component target is an explicit wider scope.
CREATE TABLE access.moderation_decision_target (
    decision_id uuid NOT NULL REFERENCES access.moderation_decision(id),
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 64),
    owner text NOT NULL CHECK (owner IN ('graph', 'content', 'source', 'media')),
    resource text NOT NULL CHECK (length(resource) BETWEEN 1 AND 512),
    component text NOT NULL CHECK (component IN
        ('name', 'title', 'body', 'structure', 'media_use', 'synopsis', 'cover', 'publication', 'record')),
    locator text CHECK (locator IS NULL OR length(locator) BETWEEN 1 AND 512),
    scope_kind text NOT NULL CHECK (scope_kind IN ('exact_revision', 'component')),
    revision text CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 512),
    expected_head text CHECK (expected_head IS NULL OR length(expected_head) BETWEEN 1 AND 512),
    effect text NOT NULL CHECK (effect IN ('disclosure', 'publication', 'participation', 'capability',
        'search', 'raw_delivery', 'media_delivery', 'export', 'source_apply')),
    PRIMARY KEY (decision_id, ordinal),
    UNIQUE NULLS NOT DISTINCT (decision_id, owner, resource, component, revision, effect),
    CHECK ((scope_kind = 'exact_revision') = (revision IS NOT NULL))
);
CREATE INDEX moderation_decision_target_lookup ON access.moderation_decision_target
    (owner, resource, component, decision_id);
CREATE TRIGGER moderation_decision_target_immutable BEFORE UPDATE OR DELETE
    ON access.moderation_decision_target
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();

-- Appeals, uploader notices, counter-notices and restoration windows are process
-- records with deadlines. None of them changes enforcement; only a later
-- attributable decision (answers_step_id) can restore.
CREATE TABLE access.governance_process_step (
    id uuid PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    decision_id uuid NOT NULL,
    process text NOT NULL CHECK (process IN ('platform_appeal', 'dmca_512', 'ordinary_dispute')),
    step text NOT NULL CHECK (step IN ('appeal', 'uploader_notice', 'counter_notice',
        'claimant_notice', 'restoration_window', 'claimant_action')),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    party_subject text REFERENCES access.authority_subject(id),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    statement text CHECK (statement IS NULL OR length(statement) BETWEEN 1 AND 8000),
    document_digest text CHECK (document_digest IS NULL OR document_digest ~ '^[0-9a-f]{64}$'),
    occurred_at timestamptz NOT NULL,
    due_at timestamptz,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (principal_id, idempotency_key),
    UNIQUE (case_id, id),
    FOREIGN KEY (case_id, decision_id) REFERENCES access.moderation_decision(case_id, id),
    CHECK (due_at IS NULL OR due_at > occurred_at),
    CHECK (step NOT IN ('uploader_notice', 'counter_notice', 'claimant_notice', 'restoration_window',
        'claimant_action') OR process = 'dmca_512')
);
CREATE INDEX governance_step_case_page ON access.governance_process_step (case_id, recorded_at, id);
CREATE INDEX governance_step_decision_fk ON access.governance_process_step (case_id, decision_id);
CREATE INDEX governance_step_due ON access.governance_process_step (due_at, id) WHERE due_at IS NOT NULL;
CREATE INDEX governance_step_party_fk ON access.governance_process_step (party_subject)
    WHERE party_subject IS NOT NULL;
CREATE TRIGGER governance_process_step_immutable BEFORE UPDATE OR DELETE
    ON access.governance_process_step
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();

ALTER TABLE access.moderation_decision
    ADD COLUMN answers_step_id uuid UNIQUE,
    ADD CONSTRAINT moderation_decision_answers_step_fk FOREIGN KEY (case_id, answers_step_id)
        REFERENCES access.governance_process_step(case_id, id);

-- Effective enforcement fence per target, effect, authority scope and context.
-- The decision, this head and its outbox fact commit together; propagation to
-- search, caches, notifications and media follows the advanced fence epoch.
CREATE TABLE access.governance_enforcement (
    id uuid PRIMARY KEY,
    authority_scope_id text NOT NULL REFERENCES access.scope_gate(id),
    context text NOT NULL,
    owner text NOT NULL CHECK (owner IN ('graph', 'content', 'source', 'media')),
    resource text NOT NULL CHECK (length(resource) BETWEEN 1 AND 512),
    component text NOT NULL,
    revision text,
    effect text NOT NULL,
    decision_id uuid NOT NULL,
    decision_ordinal smallint NOT NULL,
    state text NOT NULL CHECK (state IN ('restricted', 'released')),
    fence_epoch bigint NOT NULL CHECK (fence_epoch >= 1),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (decision_id, decision_ordinal)
        REFERENCES access.moderation_decision_target(decision_id, ordinal)
);
CREATE UNIQUE INDEX governance_enforcement_target ON access.governance_enforcement
    (owner, resource, component, revision, effect, context, authority_scope_id) NULLS NOT DISTINCT;
CREATE INDEX governance_enforcement_scope_fk ON access.governance_enforcement (authority_scope_id);
CREATE INDEX governance_enforcement_decision_fk ON access.governance_enforcement (decision_id, decision_ordinal);

CREATE FUNCTION access.guard_governance_enforcement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'governance enforcement is released by decision, never deleted' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM access.moderation_decision_target t
        JOIN access.moderation_decision d ON d.id = t.decision_id
        WHERE t.decision_id = NEW.decision_id AND t.ordinal = NEW.decision_ordinal
          AND t.owner = NEW.owner AND t.resource = NEW.resource AND t.component = NEW.component
          AND t.revision IS NOT DISTINCT FROM NEW.revision AND t.effect = NEW.effect
          AND d.authority_scope_id = NEW.authority_scope_id AND d.context = NEW.context
          AND ((NEW.state = 'restricted' AND d.outcome IN ('reject', 'restrict', 'interim_restrict', 'final_restrict'))
            OR (NEW.state = 'released' AND d.outcome IN ('restore', 'reverse', 'dismiss')))) THEN
        RAISE EXCEPTION 'governance enforcement must follow its decision target' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.fence_epoch <> 1 THEN
            RAISE EXCEPTION 'governance enforcement starts at fence epoch one' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id <> OLD.id OR NEW.authority_scope_id <> OLD.authority_scope_id OR NEW.context <> OLD.context
        OR NEW.owner <> OLD.owner OR NEW.resource <> OLD.resource OR NEW.component <> OLD.component
        OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.effect <> OLD.effect
        OR NEW.fence_epoch <> OLD.fence_epoch + 1 OR NEW.decision_id = OLD.decision_id THEN
        RAISE EXCEPTION 'governance enforcement fence must advance by one new decision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER governance_enforcement_guard BEFORE INSERT OR UPDATE OR DELETE
    ON access.governance_enforcement
    FOR EACH ROW EXECUTE FUNCTION access.guard_governance_enforcement();

-- Reuse the Access outbox for the committed decision fact. Graph-dispatched
-- decisions already publish their admission facts and do not add this kind.
ALTER TABLE access.outbox ADD COLUMN moderation_decision_id uuid
    REFERENCES access.moderation_decision(id);
ALTER TABLE access.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE access.outbox ADD CONSTRAINT outbox_kind_check CHECK
    (kind IN ('admission.registered', 'admission.claimed', 'admission.sealed',
              'scope.closed', 'scope.strong_closed', 'principal.deactivated',
              'account.deletion_fenced', 'moderation.decided'));
ALTER TABLE access.outbox DROP CONSTRAINT outbox_target_check;
ALTER TABLE access.outbox ADD CONSTRAINT outbox_target_check CHECK
    ((kind IN ('principal.deactivated', 'account.deletion_fenced')
      AND principal_id IS NOT NULL AND scope_id IS NULL AND admission_id IS NULL
      AND moderation_decision_id IS NULL)
     OR (kind = 'moderation.decided'
      AND moderation_decision_id IS NOT NULL AND scope_id IS NOT NULL
      AND principal_id IS NULL AND admission_id IS NULL)
     OR (kind NOT IN ('principal.deactivated', 'account.deletion_fenced', 'moderation.decided')
      AND principal_id IS NULL AND scope_id IS NOT NULL AND moderation_decision_id IS NULL));
CREATE UNIQUE INDEX access_outbox_moderation_decision ON access.outbox (moderation_decision_id)
    WHERE kind = 'moderation.decided';

-- Generalize 027 without changing its writer: existing proofs are backfilled
-- and each new proof inserts its decision in the same transaction.
CREATE FUNCTION access.record_organization_moderation_decision(proof access.organization_publication_moderation)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO access.moderation_decision (id, kind, outcome, context, admission_id, principal_id,
        acting_subject, authority_kind, authority_scope_id, authority_epoch, authority_proof_digest,
        idempotency_key, request_digest, disclosure, decided_at)
    SELECT proof.admission_id, 'organization_publication_rejection', 'reject', proof.realm, a.id,
        a.principal_id, a.acting_subject, 'realm', a.scope_id, a.authority_epoch, proof.proof_digest,
        a.idempotency_key, a.request_digest, 'private', proof.created_at
    FROM access.admission a WHERE a.id = proof.admission_id;
    INSERT INTO access.moderation_decision_target (decision_id, ordinal, owner, resource, component,
        scope_kind, revision, expected_head, effect)
    VALUES (proof.admission_id, 1, 'graph', proof.target->>'mainVersion', 'publication',
        'exact_revision', proof.target->>'selectedDraft', proof.target->>'expectedWorkHead', 'publication');
END $$;

SELECT access.record_organization_moderation_decision(m)
FROM access.organization_publication_moderation m ORDER BY m.admission_id;

CREATE FUNCTION access.mirror_organization_moderation_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM access.record_organization_moderation_decision(NEW);
    RETURN NULL;
END $$;
CREATE TRIGGER organization_moderation_decision_mirror AFTER INSERT
    ON access.organization_publication_moderation
    FOR EACH ROW EXECUTE FUNCTION access.mirror_organization_moderation_decision();
