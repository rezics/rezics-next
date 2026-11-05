-- migrate:up
-- Access owns accepted technical undo custody. This is personal technical data and
-- deliberately remains pending in the native inventory, never a nonpersonal disposition.
CREATE TABLE access.agent_identity_technical_source (
 route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
 account_id uuid NOT NULL,
 direction text NOT NULL CHECK(direction IN ('account-agent.verify','account-agent.unverify')),
 receipt_id uuid NOT NULL,
 intent jsonb NOT NULL CHECK(octet_length(intent::text)<=2048),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 source_partition integer NOT NULL,
 source_epoch integer NOT NULL CHECK(source_epoch>0),
 source_position bigint NOT NULL CHECK(source_position>0),
 source_transaction_id uuid NOT NULL,
 accepted_job_id uuid NOT NULL,
 accepted_job_epoch bigint NOT NULL CHECK(accepted_job_epoch>0),
 binding_generation bigint NOT NULL CHECK(binding_generation>0),
 binding_transaction_id uuid NOT NULL,
 workflow_id text NOT NULL CHECK(octet_length(workflow_id)<=256),
 receiving_transaction_id uuid NOT NULL,
 receiving_epoch integer NOT NULL CHECK(receiving_epoch>0),
 domain_generation bigint NOT NULL CHECK(domain_generation>0),
 receiving_position bigint NOT NULL CHECK(receiving_position>0),
 PRIMARY KEY(route,account_id,direction,receipt_id),
 CHECK(route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
 CHECK(source_partition=route/16),
 CHECK(receiving_transaction_id<>source_transaction_id),
 CHECK((direction='account-agent.verify' AND intent->>'kind'='merge'
   AND intent ?& ARRAY['kind','redirected','survivor','release']
   AND intent-ARRAY['kind','redirected','survivor','release']='{}'::jsonb)
  OR (direction='account-agent.unverify' AND intent->>'kind'='unmerge'
   AND intent ?& ARRAY['kind','original','undoJob','verificationReceipt','release']
   AND intent-ARRAY['kind','original','undoJob','verificationReceipt','release']='{}'::jsonb
   AND intent->'undoJob' ?& ARRAY['jobId','epoch']
   AND (intent->'undoJob')-ARRAY['jobId','epoch']='{}'::jsonb))
);
CREATE INDEX erasure_agent_identity_technical_source_account ON access.agent_identity_technical_source
 (account_id,route,direction,receipt_id);

-- Normalized native all-role inventory, not business attribution in the technical payload.
-- Each row covers all retained Account/Agent/Subject/job/receipt/workflow locators in its parent.
CREATE TABLE access.agent_identity_technical_role (
 route integer NOT NULL,
 account_id uuid NOT NULL,
 direction text NOT NULL,
 receipt_id uuid NOT NULL,
 role_account_id uuid NOT NULL,
 roles integer NOT NULL CHECK(roles BETWEEN 1 AND 262143),
 source_roles smallint NOT NULL CHECK(source_roles BETWEEN 0 AND 7),
 PRIMARY KEY(route,account_id,direction,receipt_id,role_account_id),
 FOREIGN KEY(route,account_id,direction,receipt_id)
  REFERENCES access.agent_identity_technical_source(route,account_id,direction,receipt_id)
);
CREATE INDEX erasure_agent_identity_technical_role_account ON access.agent_identity_technical_role
 (role_account_id,route,account_id,direction,receipt_id);
CREATE INDEX erasure_agent_identity_technical_role_owner ON access.agent_identity_technical_role
 (account_id,route,direction,receipt_id,role_account_id);

CREATE FUNCTION access.validate_identity_technical_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- The finalizer appends the actual eventful fence in this PostgreSQL transaction.
 -- A predicted position alone (or a replayed/caller-supplied transaction stamp) cannot commit.
 IF NEW.receiving_transaction_id::text IS DISTINCT FROM current_setting('access.identity_technical_transaction',true)
  OR NOT EXISTS(SELECT 1 FROM core.outbox o JOIN core.partition p USING(partition_no)
    WHERE o.partition_no=NEW.source_partition AND o.epoch=NEW.receiving_epoch
      AND o.position=NEW.receiving_position AND o.event_seq=0
      AND o.xmin::text=pg_current_xact_id()::text
      AND p.epoch=o.epoch AND p.position=o.position AND p.write_state='active')
  OR NOT EXISTS(SELECT 1 FROM access.agent_identity_technical_role r
    WHERE (r.route,r.account_id,r.direction,r.receipt_id)=
      (NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id)
      AND r.role_account_id=NEW.account_id AND (r.source_roles & 1)<>0) THEN
  RAISE EXCEPTION 'Accounts technical custody lacks same-command native receiving fence/inventory' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_technical_source_native_commit
 AFTER INSERT ON access.agent_identity_technical_source DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION access.validate_identity_technical_source();
CREATE FUNCTION access.guard_identity_technical_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Accepted Accounts technical custody requires its native consumer release';
END; $$;
CREATE TRIGGER identity_technical_source_immutable BEFORE UPDATE OR DELETE
 ON access.agent_identity_technical_source FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();
CREATE TRIGGER identity_technical_role_immutable BEFORE UPDATE OR DELETE
 ON access.agent_identity_technical_role FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();
CREATE TRIGGER identity_technical_source_no_truncate BEFORE TRUNCATE
 ON access.agent_identity_technical_source FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();
CREATE TRIGGER identity_technical_role_no_truncate BEFORE TRUNCATE
 ON access.agent_identity_technical_role FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();

-- migrate:down
DROP TABLE access.agent_identity_technical_role;
DROP TABLE access.agent_identity_technical_source;
DROP FUNCTION access.validate_identity_technical_source();
DROP FUNCTION access.guard_identity_technical_source();
