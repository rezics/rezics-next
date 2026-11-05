-- migrate:up
-- A native Account component. Neither this relation nor its technical receivers
-- discharge Semantic, Library, generated History/SDK copies or the erasure root.
CREATE TABLE access.agent_identity_reversal_settlement (
 route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
 account_id uuid NOT NULL,
 reversal_receipt_id uuid NOT NULL,
 verification_receipt_id uuid NOT NULL,
 verified jsonb NOT NULL CHECK(jsonb_typeof(verified)='object' AND octet_length(verified::text)<=8192),
 reversed jsonb NOT NULL CHECK(jsonb_typeof(reversed)='object' AND octet_length(reversed::text)<=8192),
 receivers jsonb NOT NULL CHECK(jsonb_typeof(receivers)='array' AND jsonb_array_length(receivers)=2
  AND octet_length(receivers::text)<=1024),
 partition_no integer NOT NULL CHECK(partition_no=route/16),
 owner_epoch integer NOT NULL CHECK(owner_epoch>0),
 position bigint NOT NULL CHECK(position>0),
 domain_generation bigint NOT NULL CHECK(domain_generation>0),
 transaction_id uuid NOT NULL,
 native_receipt_key text NOT NULL CHECK(octet_length(native_receipt_key)<=255),
 PRIMARY KEY(route,account_id,reversal_receipt_id),
 UNIQUE(route,account_id,verification_receipt_id),
 CHECK(route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
 CHECK(reversal_receipt_id<>verification_receipt_id),
 CHECK(verified->'receipt'=jsonb_build_object('kind','account-agent.verify','account',account_id,'receipt',verification_receipt_id)),
 CHECK(reversed->'receipt'=jsonb_build_object('kind','account-agent.unverify','account',account_id,'receipt',reversal_receipt_id))
);
CREATE INDEX erasure_agent_identity_reversal_settlement_account ON access.agent_identity_reversal_settlement
 (account_id,route,reversal_receipt_id);
-- The executor keeps the original receipt after response minimization. Do not scan
-- unrelated principals to find the terminal command by its transaction.
CREATE UNIQUE INDEX agent_identity_reversal_terminal_receipt ON core.receipt(partition_no,transaction_id)
 WHERE command_kind='access.agent-verification.reversed';

CREATE FUNCTION access.validate_identity_reversal_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 component jsonb;
 receiving jsonb;
 technical access.agent_identity_technical_source%ROWTYPE;
 idx integer;
BEGIN
 IF NEW.transaction_id::text IS DISTINCT FROM current_setting('access.identity_reversal_transaction',true)
  OR NOT EXISTS(SELECT 1 FROM core.receipt c JOIN core.outbox o
    ON (o.partition_no,o.epoch,o.position)=(c.partition_no,c.epoch,c.position)
   JOIN core.partition p ON p.partition_no=c.partition_no
   CROSS JOIN core.history_family_domain d
   WHERE c.partition_no=NEW.partition_no AND c.transaction_id=NEW.transaction_id
    AND c.command_kind='access.agent-verification.reversed' AND c.idempotency_key=NEW.native_receipt_key
    AND c.principal_kind='account' AND c.epoch=NEW.owner_epoch AND c.position=NEW.position
    AND c.xmin::text=pg_current_xact_id()::text AND o.xmin=c.xmin
    AND o.type='com.rezics.access.agent-verification.reversed.v1' AND o.event_seq=0
    AND o.subject=NEW.account_id::text
    AND o.data->>'receiptId'=NEW.reversal_receipt_id::text
    AND o.data->>'verificationReceiptId'=NEW.verification_receipt_id::text
    AND o.data->>'accountId'=NEW.account_id::text
    AND o.data->>'requestedBy'=c.principal_id::text
    AND p.epoch=NEW.owner_epoch AND p.position=NEW.position AND p.write_state='active'
    AND p.moved_to IS NULL AND d.singleton AND d.generation=NEW.domain_generation) THEN
  RAISE EXCEPTION 'Account reversal settlement lacks its original atomic terminal command' USING ERRCODE='23514';
 END IF;
 FOR idx IN 0..1 LOOP
  component := CASE WHEN idx=0 THEN NEW.verified ELSE NEW.reversed END;
  receiving := NEW.receivers->idx;
  SELECT * INTO technical FROM access.agent_identity_technical_source t
   WHERE t.route=NEW.route AND t.account_id=NEW.account_id
    AND t.direction=CASE WHEN idx=0 THEN 'account-agent.verify' ELSE 'account-agent.unverify' END
    AND t.receipt_id=CASE WHEN idx=0 THEN NEW.verification_receipt_id ELSE NEW.reversal_receipt_id END;
  IF NOT FOUND OR technical.source_digest IS DISTINCT FROM component->>'digest'
   OR jsonb_build_object('partition',technical.source_partition,'epoch',technical.source_epoch,
     'position',technical.source_position::text,'transactionId',technical.source_transaction_id)
       IS DISTINCT FROM component->'source'
   OR jsonb_build_object('partition',technical.source_partition,'epoch',technical.receiving_epoch,
     'position',technical.receiving_position::text,'transactionId',technical.receiving_transaction_id)
       IS DISTINCT FROM receiving
   OR technical.domain_generation<>NEW.domain_generation OR technical.receiving_epoch<>NEW.owner_epoch
   OR NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_receipt_binding b
    JOIN semantic.identity_epoch_receipt_claim c USING(partition_no,receipt_key,generation)
    JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
    JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no
     AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin AND c.xmin=k.xmin
    JOIN semantic.identity_epoch_native_commit u ON u.partition_no=b.partition_no
     AND u.transaction_id=b.consumer_undo_transaction_id AND u.purpose='admission'
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=n.epoch AND p.epoch=u.epoch
     AND p.position>=n.position AND p.position>=u.position AND p.write_state='active' AND p.moved_to IS NULL
    WHERE b.partition_no=NEW.partition_no AND c.receipt=component->'receipt'
     AND b.receipt_key='[' || to_json(component->'receipt'->>'kind')::text || ',' ||
      to_json(component->'receipt'->>'account')::text || ',' || to_json(component->'receipt'->>'receipt')::text || ']' 
     AND b.state='accepted' AND b.intent_digest=technical.source_digest AND c.intent_digest=b.intent_digest
     AND c.intent=technical.intent AND b.accepted_job=c.job_id AND b.accepted_epoch=c.job_epoch
     AND c.job_id=technical.accepted_job_id AND c.job_epoch=technical.accepted_job_epoch
     AND c.generation=technical.binding_generation AND k.transaction_id=technical.binding_transaction_id
     AND c.transaction_id=k.transaction_id AND p.epoch=technical.source_epoch
     AND jsonb_build_object('generation',c.generation::text,'transactionId',k.transaction_id,
       'home',c.job_home,'scope',c.scope_digest,'sources',c.sources,
       'job',jsonb_build_object('jobId',c.job_id,'epoch',c.job_epoch::text))=component->'binding'
     AND b.consumer_undo_generation::text=component->>'undoGeneration'
     AND NEW.domain_generation::text=component->>'restoreGeneration') THEN
   RAISE EXCEPTION 'Account reversal settlement lacks exact original accepted input/receiver' USING ERRCODE='23514';
  END IF;
 END LOOP;
 -- The independently accepted reversal names the verification's original accepted
 -- job as undo, never its own job. No caller flags or terminal-list inference.
 IF NOT EXISTS(SELECT 1 FROM access.agent_identity_technical_source r
  WHERE r.route=NEW.route AND r.account_id=NEW.account_id AND r.direction='account-agent.unverify'
   AND r.receipt_id=NEW.reversal_receipt_id AND r.intent->>'verificationReceipt'=NEW.verification_receipt_id::text
   AND r.intent->'undoJob'=NEW.verified->'binding'->'job'
   AND r.intent->'undoJob' IS DISTINCT FROM NEW.reversed->'binding'->'job') THEN
  RAISE EXCEPTION 'Account reversal settlement substituted the original undo job' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_reversal_settlement_native_commit
 AFTER INSERT ON access.agent_identity_reversal_settlement DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION access.validate_identity_reversal_settlement();
CREATE TRIGGER identity_reversal_settlement_immutable BEFORE UPDATE OR DELETE
 ON access.agent_identity_reversal_settlement FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();
CREATE TRIGGER identity_reversal_settlement_no_truncate BEFORE TRUNCATE
 ON access.agent_identity_reversal_settlement FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();

-- migrate:down
DROP TABLE access.agent_identity_reversal_settlement;
DROP FUNCTION access.validate_identity_reversal_settlement();
DROP INDEX core.agent_identity_reversal_terminal_receipt;
