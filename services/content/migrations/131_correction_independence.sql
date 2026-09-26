-- Reviewer independence for Content draft corrections. The key is a one-way digest of
-- the proposal identity and the proposer's private Access principal; it never leaves
-- this owner and cannot be joined across proposals. Access keeps the principal.
ALTER TABLE content.correction_proposal ADD COLUMN proposer_key text
  CHECK (proposer_key ~ '^[0-9a-f]{64}$');
