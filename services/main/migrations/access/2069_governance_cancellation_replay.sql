ALTER TABLE access.safety_decision_operation
    ADD COLUMN cancellation_principal_id uuid REFERENCES access.principal(id),
    ADD COLUMN cancellation_key text CHECK (cancellation_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
    ADD COLUMN cancellation_request_digest text CHECK (cancellation_request_digest ~ '^[0-9a-f]{64}$'),
    ADD COLUMN cancellation_result jsonb,
    ADD CONSTRAINT safety_cancellation_receipt_shape CHECK (
        (cancellation_principal_id IS NULL) = (cancellation_key IS NULL)
        AND (cancellation_request_digest IS NULL) = (cancellation_result IS NULL)
        AND (cancellation_principal_id IS NOT NULL OR cancellation_request_digest IS NULL)
        AND (cancellation_principal_id IS NULL OR cancelled)
        AND (cancellation_result IS NULL OR (
            jsonb_typeof(cancellation_result) = 'object'
            AND (cancellation_result->>'decisionId') IS NOT DISTINCT FROM decision_id::text
            AND (cancellation_result#>>'{operation,status}') IS NOT DISTINCT FROM 'cancelled'
        ))
    );

CREATE UNIQUE INDEX safety_cancellation_principal_key
    ON access.safety_decision_operation (cancellation_principal_id, cancellation_key)
    WHERE cancellation_principal_id IS NOT NULL;

-- Legacy cancelled operations have no historical intent or answer to backfill.
-- Their first post-upgrade key can bind the known decision without inventing either.
CREATE OR REPLACE FUNCTION access.guard_safety_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.decision_id <> OLD.decision_id OR (OLD.cancelled AND NOT NEW.cancelled)
       OR (OLD.cancellation_principal_id IS NOT NULL AND
           (NEW.cancellation_principal_id, NEW.cancellation_key,
            NEW.cancellation_request_digest, NEW.cancellation_result) IS DISTINCT FROM
           (OLD.cancellation_principal_id, OLD.cancellation_key,
            OLD.cancellation_request_digest, OLD.cancellation_result)) THEN
        RAISE EXCEPTION 'cancellation cannot undo, resume or replace its receipt' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
