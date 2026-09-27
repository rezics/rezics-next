-- Work creation seals its creator binding in the same Access transaction.
-- A Work has at most 32 maintainers; changes CAS the set generation.
CREATE TABLE access.work_maintainer_set (
    work text PRIMARY KEY,
    main_version text NOT NULL UNIQUE,
    creation_admission uuid NOT NULL UNIQUE REFERENCES access.admission(id),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE access.work_maintainer (
    work text NOT NULL REFERENCES access.work_maintainer_set(work),
    agent text NOT NULL REFERENCES access.authority_subject(id),
    PRIMARY KEY (work, agent)
);
CREATE INDEX work_maintainer_agent ON access.work_maintainer (agent, work);
CREATE TABLE access.work_maintainer_receipt (
    id uuid PRIMARY KEY,
    work text NOT NULL REFERENCES access.work_maintainer_set(work),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    actor text NOT NULL REFERENCES access.authority_subject(id),
    target text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (action IN ('create', 'add', 'transfer')),
    generation bigint NOT NULL,
    maintainers jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (work, generation),
    UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER work_maintainer_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.work_maintainer_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_baseline_proof_mutation();

ALTER TABLE access.baseline_admission ADD COLUMN maintainer_generation bigint
    CHECK (maintainer_generation >= 0);
-- Reply roots can be graph revision anchors as well as Content revision UUIDs.
ALTER TABLE access.baseline_admission ALTER COLUMN source_revision TYPE text USING source_revision::text;
ALTER TABLE access.baseline_admission ADD CONSTRAINT baseline_source_revision_format
    CHECK (source_revision ~ '^([0-9a-f-]{36}|https://rezics[.]com/id/[0-9a-f-]{36})$');
