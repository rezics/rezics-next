-- migrate:up
-- Append-only bounded consumer continuation. Parent custody remains immutable and retained.
-- The original accepted binding lock serializes every append and the terminal transition.
CREATE TABLE semantic.identity_epoch_source_consumer_terminal (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 custody_key bigint NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),
 previous_sequence bigint,
 state text NOT NULL CHECK(state IN ('scope','directory','discharged','transferred')),
 directory_after jsonb,
 ticket_key text CHECK(ticket_key ~ '^[0-9a-f]{64}$'),
 effect_after jsonb,
 seal_digest text CHECK(seal_digest ~ '^[0-9a-f]{64}$'),
 scope_partition integer CHECK(scope_partition BETWEEN 0 AND 4095),
 scope_epoch integer CHECK(scope_epoch>0),
 scope_position bigint CHECK(scope_position>0),
 scope_transaction_id uuid,
 replay_generation bigint NOT NULL CHECK(replay_generation>=0),
 undo_generation bigint NOT NULL CHECK(undo_generation>=0),
 restore_generation bigint NOT NULL CHECK(restore_generation>=0),
 owner_epoch integer NOT NULL CHECK(owner_epoch>0),
 transaction_id uuid NOT NULL,
 receiving_partition integer CHECK(receiving_partition BETWEEN 0 AND 4095),
 receiving_epoch integer CHECK(receiving_epoch>0),
 receiving_position bigint CHECK(receiving_position>0),
 receiving_transaction_id uuid,
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,custody_key,sequence),
 UNIQUE(partition_no,erasure_key),
 FOREIGN KEY(partition_no,custody_key) REFERENCES semantic.identity_epoch_source_consumer_custody(partition_no,erasure_key),
 FOREIGN KEY(partition_no,custody_key,previous_sequence)
  REFERENCES semantic.identity_epoch_source_consumer_terminal(partition_no,custody_key,sequence),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.erasure_source_commit(partition_no,transaction_id),
 CHECK((sequence=1 AND previous_sequence IS NULL) OR (sequence>1 AND previous_sequence IS NOT NULL AND previous_sequence=sequence-1)),
 CHECK(directory_after IS NULL OR (jsonb_typeof(directory_after)='object'
  AND jsonb_typeof(directory_after->'after')='array'
  AND jsonb_array_length(directory_after->'after')<=8)),
 CHECK(effect_after IS NULL OR (jsonb_typeof(effect_after)='object'
  AND effect_after ? 'effectKey' AND effect_after->>'disposition' IN ('OLD','NEW','first-apply','handoff'))),
 CHECK(COALESCE(jsonb_array_length(directory_after->'after')+1,0)
  +CASE WHEN effect_after IS NULL THEN 0 ELSE 2 END<=8),
 CHECK(octet_length(jsonb_build_array(directory_after,effect_after)::text)<=2048),
 CHECK((scope_partition IS NULL AND scope_epoch IS NULL AND scope_position IS NULL AND scope_transaction_id IS NULL)
  OR (scope_partition IS NOT NULL AND scope_epoch IS NOT NULL AND scope_position IS NOT NULL AND scope_transaction_id IS NOT NULL)),
 CHECK((state='transferred' AND receiving_partition=partition_no AND receiving_epoch=owner_epoch
  AND receiving_partition IS NOT NULL AND receiving_epoch IS NOT NULL AND receiving_position IS NOT NULL
  AND receiving_transaction_id IS NOT NULL) OR (state<>'transferred' AND receiving_partition IS NULL
  AND receiving_epoch IS NULL AND receiving_position IS NULL AND receiving_transaction_id IS NULL)),
 CHECK(state='scope' OR effect_after IS NULL),
 CHECK(state NOT IN ('discharged','transferred') OR directory_after IS NOT NULL),
 CHECK(scope_transaction_id IS NULL OR (ticket_key IS NOT NULL AND seal_digest IS NOT NULL))
);
CREATE TRIGGER identity_epoch_source_consumer_terminal_immutable BEFORE UPDATE OR DELETE
 ON semantic.identity_epoch_source_consumer_terminal
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_source_consumer_terminal_no_truncate BEFORE TRUNCATE
 ON semantic.identity_epoch_source_consumer_terminal
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE CONSTRAINT TRIGGER identity_epoch_source_consumer_terminal_erasure_capture
 AFTER INSERT ON semantic.identity_epoch_source_consumer_terminal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION semantic.capture_identity_source_consumer_custody_erasure();

-- migrate:down
DROP TABLE semantic.identity_epoch_source_consumer_terminal;
