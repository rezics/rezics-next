-- A recipient's one-purpose request is the private consent basis for an
-- ordinary work.create representation. The public API exposes only its handle.
CREATE TABLE access.representation_request (
    id uuid PRIMARY KEY,
    recipient_principal uuid NOT NULL REFERENCES access.principal(id),
    subject_id text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (action = 'work.create'),
    valid_until timestamptz NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recipient_principal, idempotency_key)
);

ALTER TABLE access.representation
    ADD COLUMN assigned_by_principal uuid REFERENCES access.principal(id),
    ADD COLUMN request_id uuid REFERENCES access.representation_request(id);
CREATE UNIQUE INDEX representation_request_once ON access.representation(request_id)
    WHERE request_id IS NOT NULL;

CREATE TABLE access.representation_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (action IN ('accept', 'revoke')),
    representation_id uuid NOT NULL REFERENCES access.representation(id),
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key)
);

CREATE FUNCTION access.reject_representation_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access representation request/receipt' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER representation_request_immutable
    BEFORE UPDATE OR DELETE ON access.representation_request
    FOR EACH ROW EXECUTE FUNCTION access.reject_representation_record_mutation();
CREATE TRIGGER representation_change_receipt_immutable
    BEFORE UPDATE OR DELETE ON access.representation_change_receipt
    FOR EACH ROW EXECUTE FUNCTION access.reject_representation_record_mutation();
