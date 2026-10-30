-- migrate:up
ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK
 (purpose IN ('bootstrap','admission','mapping','search-canonical-index','library-private-follow-counts',
 'identity-receiving-plan','identity-receiving-record','identity-receiving-custody'));
-- Control custody and receiving custody are separate local records, with no foreign-home FK.
CREATE TABLE semantic.identity_epoch_receiving_plan (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL CHECK(job_epoch>0),
 effect_key text NOT NULL CHECK(octet_length(effect_key) BETWEEN 1 AND 256),
 binding jsonb NOT NULL CHECK(octet_length(binding::text)<=4096),
 binding_digest text NOT NULL,
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,job_id,effect_key),
 FOREIGN KEY(partition_no,job_id) REFERENCES semantic.identity_epoch_job(partition_no,job_id),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TABLE semantic.identity_epoch_receiving_gate (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 owner_id uuid NOT NULL,
 original uuid NOT NULL,
 owner_epoch integer NOT NULL,
 pending_job uuid,
 pending_epoch bigint,
 CHECK((pending_job IS NULL)=(pending_epoch IS NULL)),
 CHECK(partition_no=((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11))/16)),
 PRIMARY KEY(partition_no,owner_id,original)
);
CREATE TABLE semantic.identity_epoch_receiving_record (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL CHECK(job_epoch>0),
 effect_key text NOT NULL CHECK(octet_length(effect_key) BETWEEN 1 AND 256),
 owner_id uuid NOT NULL,
 original uuid NOT NULL,
 owner_epoch integer NOT NULL,
 binding jsonb NOT NULL CHECK(octet_length(binding::text)<=4096),
 binding_digest text NOT NULL,
 plan jsonb NOT NULL,
 source_hold jsonb NOT NULL,
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,job_id,effect_key),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id),
 FOREIGN KEY(partition_no,owner_id,original) REFERENCES semantic.identity_epoch_receiving_gate(partition_no,owner_id,original)
);
CREATE TABLE semantic.identity_epoch_receiving_effect (
 partition_no integer NOT NULL,
 job_id uuid NOT NULL,
 effect_key text NOT NULL,
 transaction_id uuid NOT NULL,
 frontier jsonb NOT NULL CHECK(octet_length(frontier::text)<=2048 AND jsonb_array_length(frontier->'after')<=8),
 PRIMARY KEY(partition_no,job_id,effect_key),
 FOREIGN KEY(partition_no,job_id,effect_key) REFERENCES semantic.identity_epoch_receiving_record(partition_no,job_id,effect_key),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TABLE semantic.identity_epoch_receiving_custody (
 partition_no integer NOT NULL,
 job_id uuid NOT NULL,
 effect_key text NOT NULL,
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,job_id,effect_key),
 FOREIGN KEY(partition_no,job_id,effect_key) REFERENCES semantic.identity_epoch_receiving_plan(partition_no,job_id,effect_key),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TRIGGER identity_epoch_receiving_custody_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_receiving_custody
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_receiving_plan_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_receiving_plan
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_receiving_record_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_receiving_record
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_receiving_effect_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_receiving_effect
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


ALTER TABLE semantic.identity_epoch_receiving_plan ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
ALTER TABLE semantic.identity_epoch_receiving_record ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
ALTER TABLE semantic.identity_epoch_receiving_effect ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
ALTER TABLE semantic.identity_epoch_receiving_custody ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_receiving_plan_erasure_key ON semantic.identity_epoch_receiving_plan(partition_no,erasure_key);
CREATE UNIQUE INDEX identity_epoch_receiving_record_erasure_key ON semantic.identity_epoch_receiving_record(partition_no,erasure_key);
CREATE UNIQUE INDEX identity_epoch_receiving_effect_erasure_key ON semantic.identity_epoch_receiving_effect(partition_no,erasure_key);
CREATE UNIQUE INDEX identity_epoch_receiving_custody_erasure_key ON semantic.identity_epoch_receiving_custody(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_receiving_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_receiving_plan_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_plan
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();
CREATE CONSTRAINT TRIGGER identity_epoch_receiving_record_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_record
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();
CREATE CONSTRAINT TRIGGER identity_epoch_receiving_effect_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_effect
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();
CREATE CONSTRAINT TRIGGER identity_epoch_receiving_custody_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_custody
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();

-- migrate:down
DROP TABLE semantic.identity_epoch_receiving_custody;
DROP TABLE semantic.identity_epoch_receiving_effect;
DROP TABLE semantic.identity_epoch_receiving_record;
DROP TABLE semantic.identity_epoch_receiving_gate;
DROP TABLE semantic.identity_epoch_receiving_plan;
DROP FUNCTION semantic.capture_identity_receiving_erasure();
