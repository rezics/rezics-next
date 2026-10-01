-- First-boot configuration is consumed by the Access owner command. This
-- immutable singleton is both the role designation and its audit receipt.
-- Principal deactivation fences authority; configuration cannot restore it.
CREATE TABLE access.platform_administrator (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    principal_id uuid NOT NULL UNIQUE REFERENCES access.principal(id),
    role text NOT NULL CHECK (role = 'platform.administrator'),
    receipt text NOT NULL UNIQUE CHECK (receipt ~ '^urn:rezics:access-receipt:[0-9a-f]{64}$'),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (idempotency_key = 'platform-first-administrator-v1'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER platform_administrator_immutable BEFORE UPDATE OR DELETE
    ON access.platform_administrator FOR EACH ROW
    EXECUTE FUNCTION access.reject_role_record_mutation();

-- Ordinary command receipts retain exactly the controller/role selected at
-- registration; replay and claim never select a replacement authority path.
CREATE TABLE access.platform_administrator_admission (
    admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
    receipt text NOT NULL REFERENCES access.platform_administrator(receipt),
    representation_id uuid NOT NULL REFERENCES access.representation(id),
    representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
    subject_generation bigint NOT NULL CHECK (subject_generation >= 0),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0)
);
CREATE TRIGGER platform_administrator_admission_immutable BEFORE UPDATE OR DELETE
    ON access.platform_administrator_admission FOR EACH ROW
    EXECUTE FUNCTION access.reject_role_record_mutation();
