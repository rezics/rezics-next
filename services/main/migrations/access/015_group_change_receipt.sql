-- A group change and its replay result commit in the same Access transaction.
-- The key is scoped to the authenticated principal, while the digest binds the
-- selected issuer Agent, expected generation and exact requested operation.
CREATE TABLE access.group_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (action IN ('create', 'reparent', 'add-member',
        'grant', 'revoke-member', 'revoke-grant')),
    result_generation bigint NOT NULL CHECK (result_generation >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key)
);

CREATE FUNCTION access.reject_group_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access group change receipt' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER group_change_receipt_immutable
    BEFORE UPDATE OR DELETE ON access.group_change_receipt
    FOR EACH ROW EXECUTE FUNCTION access.reject_group_receipt_mutation();
