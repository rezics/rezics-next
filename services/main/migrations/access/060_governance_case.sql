-- Governance intake: one case per open target component under one responsible
-- authority scope and context. Independent reports stay separate records with
-- their own exact evidence anchors; a case never merges or rewrites them.
-- Evidence stores owner revision anchors and digests, not copied bodies, so
-- erasure and historical readability are decided by the owning revision store.
CREATE FUNCTION access.reject_governance_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable governance record' USING ERRCODE = '23514';
END $$;

CREATE TABLE access.governance_case (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('content_report', 'rights_complaint')),
    authority_kind text NOT NULL CHECK (authority_kind IN ('platform', 'realm', 'resource_owner')),
    authority_scope_id text NOT NULL REFERENCES access.scope_gate(id),
    context text NOT NULL CHECK (context = 'urn:rezics:context:global'
        OR context ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
    target_owner text NOT NULL CHECK (target_owner IN ('graph', 'content', 'source', 'media')),
    target_resource text NOT NULL CHECK (length(target_resource) BETWEEN 1 AND 512),
    target_component text NOT NULL CHECK (target_component IN
        ('name', 'title', 'body', 'structure', 'media_use', 'synopsis', 'cover', 'publication', 'record')),
    disclosure text NOT NULL CHECK (disclosure IN ('private', 'parties', 'public_summary')),
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    -- Decision-chain CAS position; 061 adds the head reference.
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    UNIQUE (id, kind),
    CHECK ((state = 'open') = (closed_at IS NULL))
);
-- Bulk and repeated reports join the one open case for the same target.
CREATE UNIQUE INDEX governance_case_open_target ON access.governance_case
    (target_owner, target_resource, target_component, context, authority_scope_id, kind)
    WHERE state = 'open';
CREATE INDEX governance_case_scope_page ON access.governance_case (authority_scope_id, state, opened_at, id);

-- The report is its own idempotent receipt: one row per (principal, key).
CREATE TABLE access.governance_report (
    id uuid PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES access.governance_case(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    statement text CHECK (statement IS NULL OR (length(statement) BETWEEN 1 AND 4000
        AND statement = btrim(statement))),
    evidence_count smallint NOT NULL CHECK (evidence_count BETWEEN 1 AND 16),
    evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (principal_id, idempotency_key),
    UNIQUE (case_id, id)
);
CREATE INDEX governance_report_case_page ON access.governance_report (case_id, received_at, id);
CREATE INDEX governance_report_acting_subject_fk ON access.governance_report (acting_subject);
CREATE TRIGGER governance_report_immutable BEFORE UPDATE OR DELETE ON access.governance_report
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();

-- Exact reported grain. Available evidence names an immutable owner revision and
-- its byte digest; empty, unavailable, erased and unsupported stay distinct and
-- never carry a fabricated body.
CREATE TABLE access.governance_evidence (
    report_id uuid NOT NULL REFERENCES access.governance_report(id),
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 16),
    owner text NOT NULL CHECK (owner IN ('graph', 'content', 'source', 'media')),
    resource text NOT NULL CHECK (length(resource) BETWEEN 1 AND 512),
    component text NOT NULL CHECK (component IN
        ('name', 'title', 'body', 'structure', 'media_use', 'synopsis', 'cover', 'publication', 'record')),
    locator text CHECK (locator IS NULL OR length(locator) BETWEEN 1 AND 512),
    revision text CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 512),
    representation text CHECK (representation IS NULL OR length(representation) BETWEEN 1 AND 128),
    revision_digest text CHECK (revision_digest IS NULL OR revision_digest ~ '^[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('available', 'empty', 'unavailable', 'erased', 'unsupported')),
    provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'
        AND octet_length(provenance::text) <= 4096),
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (report_id, ordinal),
    CHECK ((state = 'available' AND revision IS NOT NULL AND revision_digest IS NOT NULL)
        OR (state = 'empty' AND revision IS NOT NULL AND revision_digest IS NULL)
        OR (state = 'erased' AND revision IS NOT NULL)
        OR state = 'unavailable'
        OR (state = 'unsupported' AND revision IS NULL AND revision_digest IS NULL))
);
-- Reviewer, erasure and restoration lookups by exact owner revision.
CREATE INDEX governance_evidence_revision ON access.governance_evidence (owner, resource, revision, report_id)
    WHERE revision IS NOT NULL;
CREATE TRIGGER governance_evidence_immutable BEFORE UPDATE OR DELETE ON access.governance_evidence
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();

-- A rights complaint is the notice detail of one intake report; the claimant
-- may be external, so the recording principal and the claimant stay distinct.
-- A complaint is not itself a restriction or a finding of infringement.
CREATE TABLE access.rights_complaint (
    report_id uuid PRIMARY KEY,
    case_id uuid NOT NULL,
    case_kind text NOT NULL DEFAULT 'rights_complaint' CHECK (case_kind = 'rights_complaint'),
    process text NOT NULL CHECK (process IN ('dmca_512', 'ordinary_dispute')),
    claimant_kind text NOT NULL CHECK (claimant_kind IN ('rights_holder', 'authorized_agent', 'unknown')),
    claimant_name text NOT NULL CHECK (length(claimant_name) BETWEEN 1 AND 300
        AND claimant_name = btrim(claimant_name)),
    claimant_contact text CHECK (claimant_contact IS NULL OR length(claimant_contact) BETWEEN 1 AND 500),
    claimed_work text NOT NULL CHECK (length(claimed_work) BETWEEN 1 AND 1000),
    claimed_right text NOT NULL CHECK (claimed_right IN ('copyright', 'trademark', 'privacy', 'other')),
    notice_digest text NOT NULL CHECK (notice_digest ~ '^[0-9a-f]{64}$'),
    notice_received_at timestamptz NOT NULL,
    FOREIGN KEY (case_id, report_id) REFERENCES access.governance_report(case_id, id),
    FOREIGN KEY (case_id, case_kind) REFERENCES access.governance_case(id, kind)
);
CREATE INDEX rights_complaint_case_fk ON access.rights_complaint (case_id, case_kind);
CREATE TRIGGER rights_complaint_immutable BEFORE UPDATE OR DELETE ON access.rights_complaint
    FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();
