-- migrate:up
CREATE TABLE semantic.identity_epoch_mapping_withdrawal (
 partition_no integer NOT NULL,job_id uuid NOT NULL,original uuid NOT NULL,
 property text NOT NULL,target uuid NOT NULL,statement uuid NOT NULL,filter uuid NOT NULL,context uuid NOT NULL,
 unit integer NOT NULL,transaction_id uuid NOT NULL,row jsonb NOT NULL,
 PRIMARY KEY(partition_no,job_id,original,property,target,statement,filter,context),
 FOREIGN KEY(partition_no,job_id,unit) REFERENCES semantic.identity_epoch_mapping_effect(partition_no,job_id,unit),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(partition_no=(get_byte(uuid_send(original),10)*256+get_byte(uuid_send(original),11))/16),
 CHECK(octet_length(row::text)<=4096)
);
CREATE TABLE semantic.identity_epoch_mapping_undo (
 partition_no integer NOT NULL,job_id uuid NOT NULL,job_epoch bigint NOT NULL,original uuid NOT NULL,
 previous_terminal uuid NOT NULL,terminal uuid NOT NULL,unit integer NOT NULL,transaction_id uuid NOT NULL,
 fact_revision integer NOT NULL,security_revision bigint NOT NULL,release text NOT NULL,
 PRIMARY KEY(partition_no,job_id,original),
 FOREIGN KEY(partition_no,job_id,unit) REFERENCES semantic.identity_epoch_mapping_effect(partition_no,job_id,unit),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(partition_no=(get_byte(uuid_send(original),10)*256+get_byte(uuid_send(original),11))/16)
);
CREATE TRIGGER identity_epoch_mapping_withdrawal_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_mapping_withdrawal
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_mapping_undo_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_mapping_undo
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
-- Structural revisions do not change the retained fact basis. This point index
-- avoids walking a subject's merge history to find its current fact revision.
CREATE INDEX identity_epoch_mapping_fact_revision ON semantic.revision(route,subject_id,revision DESC) WHERE kind<>'merge';

CREATE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;home integer;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 IF native_tx IS NULL THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_TABLE_NAME='identity_epoch_mapping_fence' THEN home:=NEW.route/16; ELSE home:=NEW.partition_no; END IF;
 PERFORM semantic.capture_erasure_roles(home,TG_TABLE_NAME,NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;
ALTER TABLE semantic.identity_epoch_mapping_head ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_head_erasure_key ON semantic.identity_epoch_mapping_head(partition_no,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_head_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_head
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();
ALTER TABLE semantic.identity_epoch_mapping_plan ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_plan_erasure_key ON semantic.identity_epoch_mapping_plan(partition_no,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_plan_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_plan
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();
ALTER TABLE semantic.identity_epoch_mapping_effect ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_effect_erasure_key ON semantic.identity_epoch_mapping_effect(partition_no,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_effect_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_effect
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();
ALTER TABLE semantic.identity_epoch_mapping_payload ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_payload_erasure_key ON semantic.identity_epoch_mapping_payload(partition_no,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_payload_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_payload
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();
ALTER TABLE semantic.identity_epoch_mapping_generation ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_generation_erasure_key ON semantic.identity_epoch_mapping_generation(partition_no,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_generation_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_generation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();
ALTER TABLE semantic.identity_epoch_mapping_fence ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_fence_erasure_key ON semantic.identity_epoch_mapping_fence(route,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_fence_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_fence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();
ALTER TABLE semantic.identity_epoch_mapping_withdrawal ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_withdrawal_erasure_key ON semantic.identity_epoch_mapping_withdrawal(partition_no,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_withdrawal_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_withdrawal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();
ALTER TABLE semantic.identity_epoch_mapping_undo ADD COLUMN erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL;
CREATE UNIQUE INDEX identity_epoch_mapping_undo_erasure_key ON semantic.identity_epoch_mapping_undo(partition_no,erasure_key);
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_undo_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_undo
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();

-- migrate:down
-- Forward-only native withdrawal, retry and erasure custody.
