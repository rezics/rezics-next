-- migrate:up
-- Forward-only native scoped obligations. Existing registrations acquire no fence
-- until their actual completion and current owner seal have been revalidated.
CREATE TABLE semantic.identity_scope_consumer_fence (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 source_key text NOT NULL CHECK(source_key ~ '^[0-9a-f]{64}$'),
 scope_id text NOT NULL CHECK(octet_length(scope_id) BETWEEN 1 AND 256),
 registration uuid NOT NULL,
 capture_id uuid NOT NULL,
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL CHECK(job_epoch>0),
 attempt jsonb NOT NULL CHECK(octet_length(attempt::text)<=1024),
 source_generation text NOT NULL CHECK(octet_length(source_generation) BETWEEN 1 AND 256),
 completion_version bigint NOT NULL CHECK(completion_version>0),
 seal_digest text NOT NULL CHECK(seal_digest ~ '^[0-9a-f]{64}$'),
 native_epoch integer NOT NULL CHECK(native_epoch>0),
 native_position bigint NOT NULL CHECK(native_position>0),
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,source_key,scope_id,registration,job_id,job_epoch),
 FOREIGN KEY(partition_no,source_key,scope_id)
  REFERENCES semantic.identity_scope_summary(partition_no,source_key,scope_id),
 FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
  REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position)
);
CREATE TRIGGER identity_scope_consumer_fence_immutable BEFORE UPDATE OR DELETE
 ON semantic.identity_scope_consumer_fence FOR EACH ROW
 EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_scope_consumer_fence_no_truncate BEFORE TRUNCATE
 ON semantic.identity_scope_consumer_fence FOR EACH STATEMENT
 EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE FUNCTION semantic.validate_identity_scope_consumer_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM semantic.identity_scope_summary s
  JOIN semantic.identity_scope_attempt a USING(partition_no,source_key,scope_id,registration)
  JOIN semantic.identity_scope_completion c USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=s.partition_no
   AND n.transaction_id=NEW.transaction_id AND n.epoch=NEW.native_epoch
   AND n.position=NEW.native_position AND n.purpose='identity-scope-finish'
  JOIN semantic.identity_scope_consumer_fence f ON f.partition_no=NEW.partition_no
   AND f.source_key=NEW.source_key AND f.scope_id=NEW.scope_id AND f.registration=NEW.registration
   AND f.job_id=NEW.job_id AND f.job_epoch=NEW.job_epoch AND f.xmin=n.xmin
  JOIN semantic.identity_epoch_native_commit completed ON completed.partition_no=a.partition_no
   AND completed.transaction_id=a.transaction_id AND completed.purpose='identity-scope-finish'
   AND completed.xmin=a.xmin AND completed.xmin=c.xmin
   AND completed.epoch=n.epoch AND completed.position<n.position
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
   AND p.position>=n.position AND p.write_state='active' AND p.moved_to IS NULL
  WHERE s.partition_no=NEW.partition_no AND s.source_key=NEW.source_key AND s.scope_id=NEW.scope_id
   AND s.registration=NEW.registration AND s.capture_id=NEW.capture_id
   AND s.source->>'kind'='library' AND s.source->'identity'->>'scope'<>'public_output'
   AND (s.source->'identity'->>'ownerEpoch')::integer=n.epoch
   AND s.capture->>'kind'='library' AND s.scan_complete AND s.frontier->>'driver'='done'
   AND s.active=0 AND s.state IN ('ready','repair') AND a.state='finished' AND c.complete
   AND a.job_id=NEW.job_id AND a.job_epoch=NEW.job_epoch AND a.attempt=NEW.attempt
   AND c.capture_id=NEW.capture_id AND c.attempt=NEW.attempt
   AND c.source_generation=NEW.source_generation AND c.version=NEW.completion_version
   AND c.seal IS NOT NULL
 ) THEN RAISE EXCEPTION 'identity_scope_consumer_fence_not_native' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER identity_scope_consumer_fence_native
 AFTER INSERT ON semantic.identity_scope_consumer_fence DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION semantic.validate_identity_scope_consumer_fence();

-- Every writer locks the original summary before testing the retained obligation.
-- Both OLD and NEW addresses are covered; changing a registration or moving a
-- child cannot evade the old Source fence. No later writer extends it implicitly.
CREATE FUNCTION semantic.guard_identity_scope_consumer_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; old_key jsonb; new_key jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN old_key:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_key:=to_jsonb(NEW); END IF;
 FOR r IN SELECT DISTINCT (v->>'partition_no')::integer AS partition_no,
   v->>'source_key' AS source_key,v->>'scope_id' AS scope_id
  FROM (VALUES(old_key),(new_key)) keys(v) WHERE v IS NOT NULL
  ORDER BY partition_no,source_key,scope_id LOOP
  PERFORM 1 FROM semantic.identity_scope_summary s
   WHERE (s.partition_no,s.source_key,s.scope_id)=(r.partition_no,r.source_key,r.scope_id) FOR UPDATE;
  IF EXISTS(SELECT 1 FROM semantic.identity_scope_consumer_fence f
   WHERE (f.partition_no,f.source_key,f.scope_id)=(r.partition_no,r.source_key,r.scope_id)) THEN
   RAISE EXCEPTION 'identity_scope_consumer_fenced' USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER identity_scope_consumer_summary_guard BEFORE INSERT OR UPDATE OR DELETE
 ON semantic.identity_scope_summary FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();
CREATE TRIGGER identity_scope_consumer_attempt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON semantic.identity_scope_attempt FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();
CREATE TRIGGER identity_scope_consumer_completion_guard BEFORE INSERT OR UPDATE OR DELETE
 ON semantic.identity_scope_completion FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();
CREATE TRIGGER identity_scope_consumer_forward_guard BEFORE INSERT OR UPDATE OR DELETE
 ON semantic.identity_scope_forward FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();
CREATE TRIGGER identity_scope_consumer_prearm_guard BEFORE INSERT OR UPDATE OR DELETE
 ON semantic.identity_scope_prearm_receipt FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();

-- migrate:down
DROP TRIGGER identity_scope_consumer_prearm_guard ON semantic.identity_scope_prearm_receipt;
DROP TRIGGER identity_scope_consumer_forward_guard ON semantic.identity_scope_forward;
DROP TRIGGER identity_scope_consumer_completion_guard ON semantic.identity_scope_completion;
DROP TRIGGER identity_scope_consumer_attempt_guard ON semantic.identity_scope_attempt;
DROP TRIGGER identity_scope_consumer_summary_guard ON semantic.identity_scope_summary;
DROP FUNCTION semantic.guard_identity_scope_consumer_writer();
DROP TABLE semantic.identity_scope_consumer_fence;
DROP FUNCTION semantic.validate_identity_scope_consumer_fence();
