-- A newly selected home closure gets its own immutable native receipt. The
-- original receipt and suppression timestamp remain historical evidence.
ALTER TABLE relay.erasure ADD COLUMN suppression_receipt text
  CHECK (suppression_receipt IS NULL OR suppression_receipt ~ '^urn:rezics:receipt:erasure-graph:[0-9a-f]{64}$');
