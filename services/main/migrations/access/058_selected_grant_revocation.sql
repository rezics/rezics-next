-- A bounded representation admission can authorize one real grant revocation.
-- The existing immutable grant receipt retains the exact selected admission;
-- its unique reference makes the admission single-use across idempotency keys.
ALTER TABLE access.admission
    ADD CONSTRAINT admission_id_principal_unique UNIQUE (id, principal_id);
ALTER TABLE access.grant_change_receipt
    ADD COLUMN selected_admission_id uuid REFERENCES access.admission(id),
    ADD CONSTRAINT grant_change_selected_admission_revoke
        CHECK (selected_admission_id IS NULL OR action = 'revoke'),
    ADD CONSTRAINT grant_change_selected_admission_principal
        FOREIGN KEY (selected_admission_id, principal_id)
        REFERENCES access.admission(id, principal_id);
CREATE UNIQUE INDEX grant_change_selected_admission_once
    ON access.grant_change_receipt (selected_admission_id)
    WHERE selected_admission_id IS NOT NULL;
