-- migrate:up
-- Passkey removal uses the same committed floor receipt as key removal.
-- Operator credential openings remain limited to passwords and public keys.
ALTER TABLE access.credential_floor_receipt
  DROP CONSTRAINT credential_floor_receipt_purpose_check,
  ADD CONSTRAINT credential_floor_receipt_purpose_check
    CHECK (purpose IN ('set-password','remove-password','remove-key','remove-passkey'));

-- migrate:down
-- Forward-only: committed credential floor receipts must survive retries.
