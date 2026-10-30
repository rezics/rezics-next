-- migrate:up
-- A retained native obligation, deliberately NOT a terminal consumer receipt. There is no
-- transition to discharged/transferred until the exhaustive native consumer serializer exists.
CREATE TABLE semantic.identity_epoch_source_consumer_custody (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 receipt_key text NOT NULL CHECK(octet_length(receipt_key)<=160),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 source_epoch integer NOT NULL CHECK(source_epoch>0),
 source_position bigint NOT NULL CHECK(source_position>0),
 source_transaction_id uuid NOT NULL,
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL CHECK(job_epoch>0),
 barrier_account_id uuid NOT NULL,
 barrier_account_route integer NOT NULL CHECK(barrier_account_route BETWEEN 0 AND 65535),
 barrier_version integer NOT NULL CHECK(barrier_version>0),
 barrier_at timestamptz NOT NULL,
 erased_role text NOT NULL CHECK(erased_role IN ('subject','requester','decider')),
 binding_generation bigint NOT NULL CHECK(binding_generation>0),
 binding_transaction_id uuid NOT NULL,
 scope_digest text NOT NULL CHECK(octet_length(scope_digest)<=128),
 owner_epoch integer NOT NULL CHECK(owner_epoch>0),
 transaction_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'retained' CHECK(state='retained'),
 erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 PRIMARY KEY(partition_no,receipt_key,source_digest,barrier_account_id,barrier_version,barrier_at,erased_role,binding_generation),
 FOREIGN KEY(partition_no,receipt_key,binding_generation)
   REFERENCES semantic.identity_epoch_receipt_claim(partition_no,receipt_key,generation),
 FOREIGN KEY(partition_no,transaction_id)
   REFERENCES semantic.erasure_source_commit(partition_no,transaction_id),
 CHECK(barrier_account_route=(get_byte(uuid_send(barrier_account_id),10)*256+get_byte(uuid_send(barrier_account_id),11)))
);
CREATE UNIQUE INDEX identity_epoch_source_consumer_custody_erasure_key
 ON semantic.identity_epoch_source_consumer_custody(partition_no,erasure_key);
CREATE TRIGGER identity_epoch_source_consumer_custody_immutable BEFORE UPDATE OR DELETE
 ON semantic.identity_epoch_source_consumer_custody
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_source_consumer_custody_no_truncate BEFORE TRUNCATE
 ON semantic.identity_epoch_source_consumer_custody
 FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE FUNCTION semantic.capture_identity_source_consumer_custody_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_source_consumer_custody_erasure_capture
 AFTER INSERT ON semantic.identity_epoch_source_consumer_custody
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION semantic.capture_identity_source_consumer_custody_erasure();

-- migrate:down
DROP TABLE semantic.identity_epoch_source_consumer_custody;
DROP FUNCTION semantic.capture_identity_source_consumer_custody_erasure();
