-- Candidate evidence and durable pending slots are Access-owned. Unknown graph
-- outcomes keep their slot until a terminal receipt or reviewed verification.
CREATE TABLE quota.catalogue_search (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    data_epoch text NOT NULL,
    sequence bigint NOT NULL,
    input jsonb NOT NULL,
    candidates jsonb NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX catalogue_search_principal ON quota.catalogue_search(principal_id, id);
CREATE TRIGGER catalogue_search_immutable BEFORE UPDATE OR DELETE ON quota.catalogue_search
    FOR EACH ROW EXECUTE FUNCTION quota.reject_mutation();
CREATE TABLE quota.catalogue_creation (
    admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    search_id uuid NOT NULL REFERENCES quota.catalogue_search(id),
    quota_exempt boolean NOT NULL,
    data_epoch text NOT NULL
);
CREATE TABLE quota.catalogue_pending (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),
    admission_id uuid NOT NULL UNIQUE REFERENCES quota.catalogue_creation(admission_id),
    PRIMARY KEY (principal_id, slot)
);
CREATE TRIGGER catalogue_creation_immutable BEFORE UPDATE OR DELETE ON quota.catalogue_creation
    FOR EACH ROW EXECUTE FUNCTION quota.reject_mutation();
INSERT INTO access.scope_gate(id) VALUES ('catalogue:verify:root') ON CONFLICT DO NOTHING;
