-- migrate:up
-- Bind the actual accepted Auth source. Legacy receipts remain historical: no
-- guessed source, receiver or custody data is backfilled into immutable rows.
ALTER TABLE access.auth_receiving_closure ADD COLUMN continuation_id uuid;
ALTER TABLE access.auth_receiving_closure ADD COLUMN source_receipt_id uuid;
ALTER TABLE access.auth_receiving_closure ADD CONSTRAINT auth_receiving_closure_source_pair
 CHECK((continuation_id IS NULL AND source_receipt_id IS NULL)
    OR (continuation_id IS NOT NULL AND source_receipt_id IS NOT NULL));
-- Explicit non-null custody revision prevents SQL UNKNOWN accepting a partial
-- tuple. The original owner operation is still required to install any custody.
ALTER TABLE access.auth_receiving_obligation ADD CONSTRAINT auth_receiving_custody_complete
 CHECK((custody_revision IS NULL AND physical_closure IS NULL AND receiving_closure IS NULL)
    OR (custody_revision IS NOT NULL AND custody_revision>0
      AND physical_closure IS NOT NULL AND receiving_closure IS NOT NULL));
-- migrate:down
-- Forward-only source binding; immutable historical receipts are retained.
