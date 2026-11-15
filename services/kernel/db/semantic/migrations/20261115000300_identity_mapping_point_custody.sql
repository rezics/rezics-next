-- migrate:up
-- Insert-only per-home custody for one mapping job and original. A control row lives on the
-- control partition. A source row lives on the original route home and names that control row.
-- Historical pins stay; a later mismatch refuses by returning no row.
CREATE TABLE semantic.identity_epoch_mapping_point_custody (
 partition_no integer NOT NULL,
 job_id uuid NOT NULL,
 original uuid NOT NULL,
 job_epoch bigint NOT NULL,
 scope_digest text NOT NULL,
 route integer NOT NULL,
 terminal uuid NOT NULL,
 generation uuid NOT NULL,
 incarnation uuid NOT NULL,
 basis_version bigint NOT NULL,
 owner_epoch integer NOT NULL,
 control_partition integer NOT NULL,
 enrollment uuid NOT NULL,
 source_revision bigint NOT NULL,
 source_epoch integer NOT NULL,
 export_transaction uuid NOT NULL,
 prepared_transaction_id uuid NOT NULL,
 prepared_epoch integer NOT NULL,
 prepared_position bigint NOT NULL,
 acquired_transaction_id uuid NOT NULL,
 acquired_epoch integer NOT NULL,
 acquired_position bigint NOT NULL,
 registration_transaction_id uuid NOT NULL,
 registration_epoch integer NOT NULL,
 registration_position bigint NOT NULL,
 registration_xid text NOT NULL,
 install_transaction_id uuid NOT NULL,
 transaction_id uuid NOT NULL,
 proof_partition integer,
 proof_transaction_id uuid,
 proof_epoch integer,
 proof_position bigint,
 erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
 PRIMARY KEY(partition_no,job_id,original),
 FOREIGN KEY(partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(partition_no>=0 AND partition_no<=4095),
 CHECK(control_partition>=0 AND control_partition<=4095),
 CHECK(route>=0 AND route<=65535),
 CHECK(char_length(scope_digest)=64),
 CHECK(char_length(registration_xid)>0),
 CHECK(route=(get_byte(uuid_send(original),10)*256+get_byte(uuid_send(original),11))),
 CHECK(
  (partition_no=control_partition AND proof_partition IS NULL AND proof_transaction_id IS NULL AND proof_epoch IS NULL AND proof_position IS NULL)
  OR (partition_no<>control_partition AND partition_no=route/16 AND proof_partition=control_partition
   AND proof_transaction_id IS NOT NULL AND proof_epoch IS NOT NULL AND proof_position IS NOT NULL))
);
CREATE UNIQUE INDEX identity_epoch_mapping_point_custody_erasure_key
 ON semantic.identity_epoch_mapping_point_custody(partition_no,erasure_key);
CREATE TRIGGER identity_epoch_mapping_point_custody_immutable
 BEFORE UPDATE OR DELETE ON semantic.identity_epoch_mapping_point_custody
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_point_custody_erasure
 AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_point_custody
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();

-- migrate:down
-- Forward-only mapping point custody.
