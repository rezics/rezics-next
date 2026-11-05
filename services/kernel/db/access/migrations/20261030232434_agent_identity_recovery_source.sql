-- migrate:up
-- Keep the retained native reversal branch intact. New Source references use the
-- same immutable association, with distinct Account, Source and recovery components.
-- PostgreSQL assigns a table-level name to the two-column equality check.
DO $$ DECLARE original_check text;
BEGIN
  SELECT conname INTO STRICT original_check FROM pg_constraint
  WHERE conrelid='access.agent_identity_recovery'::regclass AND contype='c'
    AND pg_get_expr(conbin,conrelid)='(source_transaction_id = receipt_id)';
  EXECUTE format('ALTER TABLE access.agent_identity_recovery DROP CONSTRAINT %I',original_check);
END; $$;
ALTER TABLE access.agent_identity_recovery
  DROP CONSTRAINT agent_identity_recovery_direction_check,
  ALTER COLUMN verification_intent_digest DROP NOT NULL,
  ADD COLUMN original_source jsonb,
  ADD COLUMN recovery_digest text,
  ADD CHECK (direction IN ('account-agent.verify','account-agent.unverify')),
  ADD CHECK (direction<>'account-agent.unverify' OR source_transaction_id=receipt_id),
  ADD CHECK (original_source IS NOT NULL OR
    (direction='account-agent.unverify' AND verification_intent_digest IS NOT NULL AND recovery_digest IS NULL)),
  ADD CHECK ((original_source IS NULL)=(recovery_digest IS NULL)),
  ADD CHECK (recovery_digest ~ '^[0-9a-f]{64}$');

ALTER FUNCTION access.agent_identity_recovery_valid(access.agent_identity_intent)
  RENAME TO agent_identity_retained_recovery_valid;

-- Local exact accepted claim only. Foreign job/source/participant reads belong to
-- readOriginalAccountAgentIdentity before this Account checkout is acquired.
CREATE FUNCTION access.agent_identity_original_source_valid(home integer,s jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM semantic.identity_epoch_receipt_binding b
  JOIN semantic.identity_epoch_receipt_claim c
    ON (c.partition_no,c.receipt_key,c.generation)=(b.partition_no,b.receipt_key,b.generation)
  JOIN semantic.identity_epoch_receipt_claim_commit k
    ON (k.partition_no,k.receipt_key,k.generation,k.transaction_id)=
       (c.partition_no,c.receipt_key,c.generation,c.transaction_id)
  JOIN semantic.identity_epoch_native_commit n
    ON (n.partition_no,n.transaction_id)=(c.partition_no,c.transaction_id)
    AND n.purpose='admission' AND n.xmin=k.xmin AND n.xmin=c.xmin
  JOIN core.partition p ON p.partition_no=c.partition_no AND p.write_state='active'
    AND p.epoch=n.epoch AND p.position>=n.position AND n.position>0
  WHERE b.partition_no=home AND b.receipt_key=s->'claim'->>'key'
    AND b.account_id::text=s->'input'->'receipt'->>'account' AND b.state='accepted'
    AND b.intent_digest=c.intent_digest AND (b.accepted_job,b.accepted_epoch)=(c.job_id,c.job_epoch)
    AND NOT c.imported AND c.xmin::text<>pg_current_xact_id()::text
    AND c.intent=s->'input'->'intent' AND c.receipt=s->'input'->'receipt' AND c.intent_digest=s->>'digest'
    AND s->'native'=jsonb_build_object('partition',n.partition_no,'epoch',n.epoch,
      'position',n.position::text,'transactionId',n.transaction_id::text)
    AND s->'job'=jsonb_build_object('jobId',c.job_id::text,'epoch',c.job_epoch::text)
    AND s->'claim'=jsonb_build_object('partition',c.partition_no,'key',c.receipt_key,
      'generation',c.generation::text,'transactionId',c.transaction_id::text,
      'home',c.job_home,'scope',c.scope_digest,'sources',c.sources)
 );
$$;

CREATE FUNCTION access.agent_identity_recovery_valid(i access.agent_identity_intent) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM access.agent_identity_recovery a WHERE
     (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
     AND a.original_source IS NOT NULL
 ) THEN access.agent_identity_retained_recovery_valid(i) ELSE EXISTS (
  SELECT 1 FROM access.agent_identity_recovery a
  JOIN core.receipt r ON r.partition_no=a.source_partition AND r.principal_kind='account'
    AND r.principal_id=a.requested_by AND r.command_kind=i.native_command_kind
    AND r.idempotency_key=i.native_receipt_key AND r.transaction_id=a.source_transaction_id
    AND r.epoch=a.source_epoch AND r.position=a.source_position AND r.payload_state='present'
    AND r.xmin::text<>pg_current_xact_id()::text
  JOIN core.receipt c ON c.partition_no=a.source_partition AND c.principal_kind='account'
    AND c.principal_id=a.requested_by AND c.command_kind='access.agent-identity.recover'
    AND c.idempotency_key=a.recovery_receipt_key AND c.transaction_id=a.recovery_transaction_id
    AND c.epoch=a.recovery_epoch AND c.position=a.recovery_position
    AND c.xmin::text=pg_current_xact_id()::text AND c.payload_state='present'
    AND encode(c.request_digest,'hex')=a.recovery_digest
    AND c.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s]',
      to_json(i.delivery_key),to_json(i.source_transaction_id::text),i.source_epoch,to_json(i.source_position::text),
      to_json(i.intent_digest),COALESCE(to_json(a.verification_intent_digest)::text,'null'),
      (a.original_source->'native'->'transactionId')::text,(a.original_source->'native'->'epoch')::text,
      (a.original_source->'native'->'position')::text,(a.original_source->'claim'->'generation')::text,
      (a.original_source->'job'->'jobId')::text,(a.original_source->'job'->'epoch')::text,
      (a.original_source->'claim'->'scope')::text,COALESCE(to_json(i.decision_transaction_id::text)::text,'null'),
      COALESCE(i.decision_epoch::text,'null'),COALESCE(to_json(i.decision_position::text)::text,'null')),'UTF8'))
  JOIN core.partition p ON p.partition_no=a.source_partition AND p.write_state='active'
    AND p.epoch=a.source_epoch AND p.position>=a.recovery_position
  WHERE (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
    AND a.xmin::text=pg_current_xact_id()::text
    AND a.requested_by=i.requested_by AND a.decided_by IS NOT DISTINCT FROM i.decided_by
    AND a.source_partition=i.source_partition AND a.source_epoch=i.source_epoch
    AND a.source_position=i.source_position AND a.source_transaction_id=i.source_transaction_id
    AND a.intent_digest=i.intent_digest AND NOT i.minimized
    AND i.pending_receipt_id=r.transaction_id
    AND i.delivery_key=format('["%s","%s","%s"]',i.direction,i.account_id::text,i.receipt_id::text)
    AND a.original_source->'input'=jsonb_build_object('intent',i.intent,'receipt',
      jsonb_build_object('account',i.account_id::text,'kind',i.direction,'receipt',i.receipt_id::text))
    AND a.original_source->>'digest'=i.intent_digest
    AND i.intent->>'release'=i.release
    AND access.agent_identity_original_source_valid(i.source_partition,a.original_source)
    -- The original Source admission must never masquerade as the Account command.
    AND a.original_source->'native'->>'transactionId'<>i.source_transaction_id::text
    AND a.original_source->'native'->>'transactionId'<>a.recovery_transaction_id::text
    AND (a.original_source->'native'->>'position')::bigint>i.source_position
    AND (a.original_source->'native'->>'position')::bigint<a.recovery_position
    AND ((i.direction='account-agent.verify'
      AND a.original_source->'priorVerification'='null'::jsonb
      AND a.verification_intent_digest IS NULL AND i.verification_receipt_id IS NULL
      AND i.decided_by IS NOT NULL AND i.decision_route=0 AND i.decision_receipt_id=i.receipt_id
      AND i.decision_transaction_id=i.receipt_id AND i.decision_epoch>0 AND i.decision_position>0
      AND i.intent=jsonb_build_object('kind','merge','redirected',i.agent_id::text,
        'survivor',i.catalogue_id::text,'release',i.release)
      AND i.workflow_id='accounts.agent-verification:'||i.request_id::text||':'||i.receipt_id::text
      AND r.command_kind='access.agent-verification.pending'
      AND r.response=jsonb_build_object('requestId',i.request_id::text,'accountId',i.account_id::text)
      AND r.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s]',to_json(i.request_id::text),
        to_json(i.account_id::text),to_json(i.account_kind),to_json(i.catalogue_id::text),
        to_json(i.receipt_id::text)),'UTF8')))
    OR (i.direction='account-agent.unverify'
      AND access.agent_identity_original_source_valid(i.source_partition,a.original_source->'priorVerification')
      AND (a.original_source->'priorVerification'->'native'->>'position')::bigint<i.source_position
      AND a.original_source->'priorVerification'->>'verificationReceipt'=i.verification_receipt_id::text
      AND a.original_source->'priorVerification'->>'digest'=a.verification_intent_digest
      AND a.original_source->'priorVerification'->'input'=jsonb_build_object('intent',
        jsonb_build_object('kind','merge','redirected',i.agent_id::text,'survivor',i.catalogue_id::text,'release',i.release),
        'receipt',jsonb_build_object('account',i.account_id::text,'kind','account-agent.verify',
          'receipt',i.verification_receipt_id::text))
      AND a.original_source->'priorVerification'->'job'=i.intent->'undoJob'
      AND i.intent=jsonb_build_object('kind','unmerge','original',i.agent_id::text,'release',i.release,
        'verificationReceipt',i.verification_receipt_id::text,'undoJob',
        jsonb_build_object('jobId',i.undo_job_id::text,'epoch',i.undo_job_epoch::text))
      AND i.request_id IS NULL AND i.decision_route IS NULL AND i.decision_receipt_id IS NULL
      AND i.decision_epoch IS NULL AND i.decision_position IS NULL AND i.decision_transaction_id IS NULL
      AND i.workflow_id='accounts.agent-verification-reversal:'||i.account_id::text||':'||i.receipt_id::text
      AND r.response=jsonb_build_object('accountId',i.account_id::text,'receiptId',i.receipt_id::text,
        'requestedBy',i.requested_by::text,'kind',i.disposition,'reason',i.reason,
        'catalogueSubjectId',i.catalogue_id::text,'verificationReceiptId',i.verification_receipt_id::text)
      AND i.decided_by IS NOT DISTINCT FROM CASE WHEN i.disposition='revoked' THEN i.requested_by END
      AND ((r.command_kind='access.agent-verification.deleted' AND i.disposition='revoked'
        AND i.reason='Account deleted' AND i.requested_by=i.account_id
        AND r.request_digest=sha256(convert_to(i.account_id::text,'UTF8'))
        AND EXISTS (SELECT 1 FROM access.account t WHERE t.route=i.route AND t.account_id=i.account_id AND t.state='deleted'))
      OR (r.command_kind='access.agent-verification.'||i.disposition AND EXISTS (
        SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
          AND b.principal_kind='account' AND b.principal_id=r.principal_id AND b.epoch=r.epoch AND b.position=r.position)))))
 ) END;
$$;

-- Recovery enrolls its own physical artifacts as DATA. It never reopens or seals
-- the original writer's finite inventory or fabricates its SDK handoff.
CREATE OR REPLACE FUNCTION core.agent_identity_inventory_copy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE i core.agent_identity_inventory; s access.agent_identity_intent;
 a access.agent_identity_recovery; expected bytea;
BEGIN
 SELECT * INTO s FROM access.agent_identity_intent
 WHERE route=NEW.source_route AND account_id=NEW.source_account_id
   AND direction=NEW.source_direction AND receipt_id=NEW.source_receipt_id
   AND source_partition=NEW.partition_no AND intent_digest=NEW.source_digest
   AND xmin::text=pg_current_xact_id()::text FOR SHARE;
 IF FOUND THEN
   SELECT * INTO a FROM access.agent_identity_recovery
   WHERE route=s.route AND account_id=s.account_id AND direction=s.direction AND receipt_id=s.receipt_id
     AND (source_partition,recovery_epoch,recovery_position,recovery_transaction_id)=
       (NEW.partition_no,NEW.source_epoch,NEW.source_position,NEW.source_transaction_id)
     AND xmin::text=pg_current_xact_id()::text FOR SHARE;
   IF FOUND AND access.agent_identity_recovery_valid(s) THEN
     IF NEW.artifact_type='command-receipt/v1' THEN
       expected:=decode('0101','hex') || substring(int4send(NEW.partition_no) from 3 for 2) || decode('01','hex') ||
         uuid_send(a.requested_by) || int4send(7) ||
         substring(int4send(split_part(a.recovery_receipt_key,'.',2)::integer) from 3 for 2) ||
         decode(translate(split_part(a.recovery_receipt_key,'.',3),'-_','+/') || '=', 'base64');
     ELSIF NEW.artifact_type='outbox-event/v1' THEN
       expected:=decode('0102','hex') || substring(int4send(NEW.partition_no) from 3 for 2) ||
         int8send(NEW.source_position) || decode('0000','hex');
       PERFORM 1 FROM core.outbox o WHERE o.partition_no=NEW.partition_no AND o.epoch=NEW.source_epoch
         AND o.position=NEW.source_position AND o.event_seq=0 AND o.event_count=1
         AND o.type='com.rezics.access.account-updated.v1' AND o.subject=s.account_id::text
         AND o.data=jsonb_build_object('accountId',s.account_id::text) AND o.payload_state='present'
         AND o.xmin::text=pg_current_xact_id()::text;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'Recovery copy lacks its actual account wakeup' USING ERRCODE='23514';
       END IF;
     END IF;
     IF expected IS NULL OR NEW.locator IS DISTINCT FROM expected THEN
       RAISE EXCEPTION 'Recovery copy lacks its actual native codec' USING ERRCODE='23514';
     END IF;
     RETURN NEW;
   END IF;
 END IF;
 -- Retain the exact original-writer admission rule for every other producer.
 SELECT * INTO i FROM core.agent_identity_inventory WHERE partition_no=NEW.partition_no AND source_route=NEW.source_route
   AND source_account_id=NEW.source_account_id AND source_direction=NEW.source_direction AND source_receipt_id=NEW.source_receipt_id
   AND xmin::text=pg_current_xact_id()::text FOR UPDATE;
 IF NOT FOUND OR i.state<>'declared' OR
   (NEW.source_digest,NEW.source_epoch,NEW.source_position,NEW.source_transaction_id,NEW.receiver_epoch,NEW.domain_generation)
   IS DISTINCT FROM (i.source_digest,i.source_epoch,i.source_position,i.source_transaction_id,i.receiver_epoch,i.domain_generation) THEN
   RAISE EXCEPTION 'Identity copy requires original unsealed producer transaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Agent identity recovery source requires forward-only receiving custody'; END $$;
