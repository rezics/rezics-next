-- Account caller and institutional issuer are separate. The grant remains
-- assigned to the issuer Agent after the issuing principal departs.
ALTER TABLE access.permission_grant
    ADD COLUMN assigned_by_principal uuid REFERENCES access.principal(id);
CREATE INDEX permission_grant_work_issuer_page ON access.permission_grant (issuer_subject, id)
    WHERE scope_id = 'work:create:root' AND action = 'work.create';

CREATE TABLE access.grant_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (action IN ('create', 'revoke')),
    grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key)
);

CREATE FUNCTION access.reject_grant_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access grant change receipt' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER grant_change_receipt_immutable
    BEFORE UPDATE OR DELETE ON access.grant_change_receipt
    FOR EACH ROW EXECUTE FUNCTION access.reject_grant_receipt_mutation();
