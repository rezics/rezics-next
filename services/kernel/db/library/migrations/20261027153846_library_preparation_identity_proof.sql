-- migrate:up
-- No defaults, backfill or validation: historical immutable headers cannot gain invented versions.
ALTER TABLE library.type_preparation_header
  ADD COLUMN source_identity jsonb,
  ADD COLUMN origin_identity jsonb,
  ADD CONSTRAINT type_preparation_header_identity_check CHECK (
    source_identity IS NOT NULL AND jsonb_typeof(source_identity) = 'object'
    AND origin_identity IS NOT NULL AND jsonb_typeof(origin_identity) = 'object'
  ) NOT VALID;
ALTER TABLE library.type_preparation_progress
  ADD COLUMN last_receipt jsonb,
  ADD COLUMN last_transaction_id uuid,
  ADD CONSTRAINT type_preparation_progress_receipt_check CHECK (
    (last_receipt IS NULL AND last_transaction_id IS NULL)
    OR (last_receipt IS NOT NULL AND jsonb_typeof(last_receipt) = 'object' AND last_transaction_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT type_preparation_progress_ready_proof_check CHECK (
    state <> 'ready' OR (last_receipt IS NOT NULL AND last_transaction_id IS NOT NULL)
  ) NOT VALID;
COMMENT ON COLUMN library.type_preparation_header.source_identity IS
  'Private exact initial same-RR resolved-source latest create/identity metadata: sourceId, partition, epoch, revision, transactionId, redirect. Origin/survivor are independently anchored. Immutable header commitment includes both identities; DDL checks storage only, never authenticity. Bounded purge inventory must remove this metadata.';
COMMENT ON COLUMN library.type_preparation_header.origin_identity IS
  'Private exact initial same-RR requested-origin identity, independently anchored with the same fields as source_identity. Historical NULL headers remain immutable and prove no authority: reader returns null; an admitted producer under current owner/gate locks may replace an invalid slot with a fresh UUID. Bounded purge inventory must remove this metadata.';
COMMENT ON COLUMN library.type_preparation_header.creation_commitment IS
  'Commits preparation, owner, full binding, origin, source_identity, origin_identity, principal/input association and creator receipt locator, excluding this commitment field itself and mutable progress including last_receipt. Publication and key payload remain exact native evidence.';
COMMENT ON COLUMN library.type_preparation_progress.last_receipt IS
  'Private mutable native core receipt locator, excluded from immutable header commitment. Creator/page stores locator and actual transaction with corresponding core receipt response in the SAME command. JSON alone is not authority: reader/consumer independently verifies real core row partition/account/kind/key/digest/transaction, full header commitment, root/final state/checkpoint/typeId response. No receipt FK: shared retention is bounded; collection fails closed. Bounded purge inventory must remove locators.';
COMMENT ON COLUMN library.type_preparation_progress.last_transaction_id IS
  'Actual core receipt transaction paired with last_receipt, not hash-only proof. Historical ready rows lacking proof are never served as ready; replace/reobserve through an admitted producer. Pending historical metadata gains no authority. DDL authenticates nothing.';
-- migrate:down
-- Forward only: retained provenance requires explicit fenced retirement.
