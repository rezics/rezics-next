-- migrate:up
-- The requested restriction survives lost acknowledgements and proof expiry.
-- It deliberately has no foreign key to the independently collected proof.
ALTER TABLE auth_consent
  ADD COLUMN pending_scopes text[],
  ADD COLUMN pending_reference text,
  ADD CONSTRAINT auth_consent_pending_pair CHECK
    ((pending_scopes IS NULL) = (pending_reference IS NULL));

-- migrate:down
-- Forward only: removing an unresolved ceiling could restore revoked scopes.
