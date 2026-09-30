CREATE TABLE access.editorial_proposal (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]{0,63}$'),
    target jsonb NOT NULL,
    resource text NOT NULL,
    context text NOT NULL,
    work text,
    proposer_principal uuid NOT NULL REFERENCES access.principal(id),
    proposer_agent text NOT NULL REFERENCES access.authority_subject(id),
    proposer_key text NOT NULL CHECK (proposer_key ~ '^[0-9a-f]{64}$'),
    proposer_controllers uuid[] NOT NULL CHECK (cardinality(proposer_controllers) BETWEEN 1 AND 16),
    reverts uuid REFERENCES access.editorial_proposal(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX editorial_proposal_mine ON access.editorial_proposal (proposer_principal, created_at DESC, id DESC);
CREATE INDEX editorial_proposal_target ON access.editorial_proposal (resource, created_at DESC, id DESC);
CREATE INDEX editorial_proposal_queue ON access.editorial_proposal (created_at DESC, id DESC);

CREATE TABLE access.editorial_revision (
    proposal uuid NOT NULL REFERENCES access.editorial_proposal(id),
    n integer NOT NULL CHECK (n > 0),
    candidate text NOT NULL CHECK (octet_length(candidate) <= 1048576),
    candidate_digest text NOT NULL CHECK (candidate_digest = encode(sha256(convert_to(candidate, 'UTF8')), 'hex')),
    before_state text NOT NULL CHECK (octet_length(before_state) <= 1048576),
    base_heads jsonb NOT NULL CHECK (jsonb_typeof(base_heads) = 'array' AND jsonb_array_length(base_heads) BETWEEN 1 AND 32),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 32),
    owner_command jsonb,
    author_agent text NOT NULL REFERENCES access.authority_subject(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (proposal, n)
);
CREATE TABLE access.editorial_review (
    id uuid PRIMARY KEY,
    proposal uuid NOT NULL,
    revision integer NOT NULL,
    principal uuid NOT NULL REFERENCES access.principal(id),
    reviewer text NOT NULL REFERENCES access.authority_subject(id),
    reviewer_key text NOT NULL CHECK (reviewer_key ~ '^[0-9a-f]{64}$'),
    outcome text NOT NULL CHECK (outcome IN ('approve','request_changes','comment')),
    message text NOT NULL CHECK (char_length(message) <= 4000),
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (proposal, revision) REFERENCES access.editorial_revision(proposal, n)
);
CREATE INDEX editorial_review_stance ON access.editorial_review (proposal, revision, principal, sequence DESC)
    WHERE outcome <> 'comment';
CREATE INDEX editorial_review_outcome ON access.editorial_review (proposal, revision, outcome, sequence DESC)
    WHERE outcome <> 'comment';
CREATE INDEX editorial_review_approval_history ON access.editorial_review (proposal, sequence DESC)
    WHERE outcome = 'approve';
CREATE INDEX editorial_review_timeline ON access.editorial_review (proposal, sequence);

CREATE TABLE access.editorial_decision (
    proposal uuid PRIMARY KEY REFERENCES access.editorial_proposal(id),
    revision integer NOT NULL,
    principal uuid NOT NULL REFERENCES access.principal(id),
    actor text NOT NULL REFERENCES access.authority_subject(id),
    outcome text NOT NULL CHECK (outcome IN ('applied','rejected','withdrawn')),
    owner_receipt jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (proposal, revision) REFERENCES access.editorial_revision(proposal, n),
    CHECK ((outcome = 'applied') = (owner_receipt IS NOT NULL))
);
CREATE TABLE access.editorial_command_receipt (
    principal uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    proposal uuid NOT NULL REFERENCES access.editorial_proposal(id),
    result jsonb NOT NULL,
    PRIMARY KEY (principal, idempotency_key)
);
CREATE FUNCTION access.editorial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'editorial records are immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER editorial_proposal_immutable BEFORE UPDATE OR DELETE ON access.editorial_proposal
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_revision_immutable BEFORE UPDATE OR DELETE ON access.editorial_revision
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_review_immutable BEFORE UPDATE OR DELETE ON access.editorial_review
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_decision_immutable BEFORE UPDATE OR DELETE ON access.editorial_decision
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_command_receipt_immutable BEFORE UPDATE OR DELETE ON access.editorial_command_receipt
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
