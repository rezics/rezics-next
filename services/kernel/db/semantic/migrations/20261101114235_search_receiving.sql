-- migrate:up
-- Operational continuation is a child of the existing immutable accepted ledger, not a receipt.
-- Erasure of its accepted parent also removes these keys; it carries no independent role inventory.
CREATE TABLE semantic.identity_epoch_receiving_search_progress (
 partition_no integer NOT NULL,
 job_id uuid NOT NULL,
 effect_key text NOT NULL,
 owner_id uuid NOT NULL,
 original uuid NOT NULL,
 accepted_transaction_id uuid NOT NULL,
 binding_digest text NOT NULL,
 applied_transaction_id uuid,
 released_transaction_id uuid,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 after_key text CHECK(octet_length(after_key) BETWEEN 1 AND 2048),
 state text NOT NULL DEFAULT 'progress' CHECK(state IN ('progress','settled','released')),
 CHECK(state='progress' OR applied_transaction_id IS NOT NULL),
 CHECK((state='released')=(released_transaction_id IS NOT NULL)),
 PRIMARY KEY(partition_no,job_id,effect_key),
 FOREIGN KEY(partition_no,released_transaction_id)
   REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id),
 FOREIGN KEY(partition_no,job_id,effect_key)
   REFERENCES semantic.identity_epoch_receiving_record(partition_no,job_id,effect_key) ON DELETE CASCADE
);
CREATE INDEX identity_epoch_receiving_search_unreleased
 ON semantic.identity_epoch_receiving_search_progress(partition_no,job_id,owner_id,original)
 WHERE state<>'released';
-- Backfill only operational keys; native custody must still be revalidated and reconciled.
INSERT INTO semantic.identity_epoch_receiving_search_progress
 (partition_no,job_id,effect_key,owner_id,original,accepted_transaction_id,binding_digest)
 SELECT partition_no,job_id,effect_key,owner_id,original,transaction_id,binding_digest
 FROM semantic.identity_epoch_receiving_record WHERE binding->>'step'='search-canonical-index';

-- migrate:down
DROP TABLE semantic.identity_epoch_receiving_search_progress;
