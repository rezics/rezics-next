CREATE TABLE access.editorial_application (
    id uuid PRIMARY KEY,
    proposal uuid NOT NULL,
    revision integer NOT NULL,
    principal uuid NOT NULL REFERENCES access.principal(id),
    actor text NOT NULL REFERENCES access.authority_subject(id),
    operation_key text NOT NULL UNIQUE,
    command_key text NOT NULL,
    command_digest text NOT NULL,
    approve boolean NOT NULL,
    required integer NOT NULL CHECK (required BETWEEN 1 AND 2),
    message text NOT NULL CHECK (char_length(message) <= 4000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (proposal, revision),
    UNIQUE (principal, command_key),
    FOREIGN KEY (proposal, revision) REFERENCES access.editorial_revision(proposal, n)
);
CREATE TABLE access.editorial_application_outcome (
    application uuid PRIMARY KEY REFERENCES access.editorial_application(id),
    outcome text NOT NULL CHECK (outcome IN ('applied','stale_base','cancelled')),
    owner_receipt jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((outcome = 'applied') = (owner_receipt IS NOT NULL))
);
CREATE TABLE access.editorial_owner_admission (
    application uuid PRIMARY KEY REFERENCES access.editorial_application(id),
    admission uuid NOT NULL UNIQUE REFERENCES access.admission(id)
);
CREATE TRIGGER editorial_application_immutable BEFORE UPDATE OR DELETE ON access.editorial_application
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_application_outcome_immutable BEFORE UPDATE OR DELETE ON access.editorial_application_outcome
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_owner_admission_immutable BEFORE UPDATE OR DELETE ON access.editorial_owner_admission
    FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();

-- The proposal row lock serializes ALL immutable appends, including raw owner
-- calls. An unresolved application cannot be revised, withdrawn or rejected.
CREATE FUNCTION access.editorial_append_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest integer; wanted integer;
BEGIN
    PERFORM 1 FROM access.editorial_proposal WHERE id = NEW.proposal FOR UPDATE;
    SELECT max(n) INTO latest FROM access.editorial_revision WHERE proposal = NEW.proposal;
    IF EXISTS (SELECT 1 FROM access.editorial_decision WHERE proposal = NEW.proposal) THEN
        RAISE EXCEPTION 'editorial proposal already decided' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'editorial_revision' THEN
        wanted := coalesce(latest, 0) + 1;
        IF NEW.n <> wanted THEN RAISE EXCEPTION 'editorial revision is stale' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.revision IS DISTINCT FROM latest THEN
        RAISE EXCEPTION 'editorial revision is stale' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM access.editorial_application a
        WHERE a.proposal = NEW.proposal AND NOT EXISTS (
            SELECT 1 FROM access.editorial_application_outcome o WHERE o.application = a.id))
        THEN
        RAISE EXCEPTION 'editorial application is pending' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'editorial_decision' THEN
      IF NEW.outcome = 'applied' AND NOT EXISTS (
        SELECT 1 FROM access.editorial_application a JOIN access.editorial_application_outcome o ON o.application = a.id
        WHERE a.proposal = NEW.proposal AND a.revision = NEW.revision AND o.outcome = 'applied'
          AND a.actor = NEW.actor AND a.principal = NEW.principal AND o.owner_receipt = NEW.owner_receipt) THEN
        RAISE EXCEPTION 'editorial application receipt is missing' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER editorial_revision_guard BEFORE INSERT ON access.editorial_revision
    FOR EACH ROW EXECUTE FUNCTION access.editorial_append_guard();
CREATE TRIGGER editorial_review_guard BEFORE INSERT ON access.editorial_review
    FOR EACH ROW EXECUTE FUNCTION access.editorial_append_guard();
CREATE TRIGGER editorial_application_guard BEFORE INSERT ON access.editorial_application
    FOR EACH ROW EXECUTE FUNCTION access.editorial_append_guard();
CREATE TRIGGER editorial_decision_guard BEFORE INSERT ON access.editorial_decision
    FOR EACH ROW EXECUTE FUNCTION access.editorial_append_guard();
