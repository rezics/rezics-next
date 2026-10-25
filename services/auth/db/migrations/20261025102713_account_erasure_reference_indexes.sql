-- migrate:up
-- Bound native owner cascades to this account's recovery bindings and openings.
-- Building these indexes is deployment maintenance, outside the erasure request.
CREATE INDEX auth_recovery_account_id_idx ON auth_recovery (account_id);
CREATE INDEX auth_session_opening_subject_account_id_idx ON auth_session_opening (subject_account_id);

-- migrate:down
-- Forward-only: retain the bounded account-erasure access paths.
