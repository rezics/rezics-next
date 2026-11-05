-- migrate:up
-- Receipt discovery is by an exact original native transaction, never by response JSON.
CREATE UNIQUE INDEX agent_identity_reversal_original ON core.receipt(partition_no,transaction_id)
WHERE principal_kind='account' AND command_kind IN
 ('access.agent-verification.released','access.agent-verification.revoked','access.agent-verification.deleted');
CREATE UNIQUE INDEX agent_identity_decision_original ON access.agent_verification_request
 (route,account_id,decision_receipt_id) WHERE decision_receipt_id IS NOT NULL;

CREATE TABLE access.agent_identity_recovery (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL CHECK (direction='account-agent.unverify'),
    receipt_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    decided_by uuid,
    source_partition integer NOT NULL CHECK (source_partition=route/16),
    source_epoch integer NOT NULL CHECK (source_epoch>0),
    source_position bigint NOT NULL CHECK (source_position>0),
    source_transaction_id uuid NOT NULL CHECK (source_transaction_id=receipt_id),
    intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
    verification_intent_digest text NOT NULL CHECK (verification_intent_digest ~ '^[0-9a-f]{64}$'),
    recovery_transaction_id uuid NOT NULL CHECK (recovery_transaction_id<>source_transaction_id),
    recovery_epoch integer NOT NULL CHECK (recovery_epoch=source_epoch),
    recovery_position bigint NOT NULL CHECK (recovery_position>source_position),
    recovery_receipt_key text NOT NULL,
    PRIMARY KEY(route,account_id,direction,receipt_id),
    FOREIGN KEY(route,account_id,direction,receipt_id)
      REFERENCES access.agent_identity_intent(route,account_id,direction,receipt_id),
    CHECK (route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))
);
CREATE INDEX erasure_agent_identity_recovery_account_id ON access.agent_identity_recovery
 (account_id,route,direction,receipt_id);
CREATE INDEX erasure_agent_identity_recovery_requested_by ON access.agent_identity_recovery
 (requested_by,route,account_id,direction,receipt_id);
CREATE INDEX erasure_agent_identity_recovery_decided_by ON access.agent_identity_recovery
 (decided_by,route,account_id,direction,receipt_id);

-- An association alone is DATA. Both the retained original and this actual recovery command must exist.
-- The native released undo reader additionally verifies publication before this command is entered.
CREATE FUNCTION access.agent_identity_recovery_valid(i access.agent_identity_intent) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM access.agent_identity_recovery a
  JOIN core.receipt r ON r.partition_no=a.source_partition AND r.principal_kind='account'
    AND r.principal_id=a.requested_by AND r.command_kind=i.native_command_kind
    AND r.idempotency_key=i.native_receipt_key AND r.transaction_id=a.source_transaction_id
    AND r.epoch=a.source_epoch AND r.position=a.source_position AND r.payload_state='present'
    AND r.xmin::text<>pg_current_xact_id()::text
  JOIN core.receipt c ON c.partition_no=a.source_partition AND c.principal_kind='account'
    AND c.principal_id=a.requested_by AND c.command_kind='access.agent-identity.recover'
    AND c.idempotency_key=a.recovery_receipt_key
    AND c.transaction_id=a.recovery_transaction_id AND c.epoch=a.recovery_epoch
    AND c.position=a.recovery_position AND c.xmin::text=pg_current_xact_id()::text
    AND c.payload_state='present'
    AND c.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s,%s]',
      to_json(i.delivery_key),to_json(i.source_transaction_id::text),i.source_epoch,
      to_json(i.source_position::text),to_json(i.intent_digest),to_json(a.verification_intent_digest)), 'UTF8'))
  JOIN core.partition p ON p.partition_no=a.source_partition AND p.write_state='active'
    AND p.epoch=a.source_epoch AND p.position>=a.recovery_position
  JOIN access.agent_identity_intent v ON v.route=i.route AND v.account_id=i.account_id
    AND v.direction='account-agent.verify' AND v.receipt_id=i.verification_receipt_id
    AND v.intent_digest=a.verification_intent_digest AND NOT v.minimized
    AND v.xmin::text<>pg_current_xact_id()::text
    AND v.source_epoch=i.source_epoch AND v.catalogue_id=i.catalogue_id
    AND v.source_position<r.position
    AND v.agent_id=i.agent_id AND v.account_kind=i.account_kind AND v.release=i.release
  WHERE (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
    AND a.xmin::text=pg_current_xact_id()::text
    AND a.requested_by=i.requested_by AND a.decided_by IS NOT DISTINCT FROM i.decided_by
    AND a.source_partition=i.source_partition AND a.source_epoch=i.source_epoch
    AND a.source_position=i.source_position AND a.source_transaction_id=i.source_transaction_id
    AND a.intent_digest=i.intent_digest AND NOT i.minimized
    AND i.direction='account-agent.unverify' AND i.pending_receipt_id=i.receipt_id
    AND i.request_id IS NULL AND i.decision_route IS NULL AND i.decision_receipt_id IS NULL
    AND i.decision_epoch IS NULL AND i.decision_position IS NULL AND i.decision_transaction_id IS NULL
    AND i.delivery_key=format('["%s","%s","%s"]',i.direction,i.account_id::text,i.receipt_id::text)
    AND i.workflow_id='accounts.agent-verification-reversal:'||i.account_id::text||':'||i.receipt_id::text
    AND i.intent=jsonb_build_object('kind','unmerge','original',i.agent_id::text,
      'undoJob',jsonb_build_object('jobId',i.undo_job_id::text,'epoch',i.undo_job_epoch::text),
      'verificationReceipt',i.verification_receipt_id::text,'release',v.release)
    AND i.intent_digest=encode(sha256(convert_to(format(
      '[{"kind":"unmerge","original":%s,"release":%s,"undoJob":{"epoch":%s,"jobId":%s},"verificationReceipt":%s},{"account":%s,"kind":"account-agent.unverify","receipt":%s}]',
      to_json(i.agent_id::text),to_json(i.release),to_json(i.undo_job_epoch::text),to_json(i.undo_job_id::text),
      to_json(i.verification_receipt_id::text),to_json(i.account_id::text),to_json(i.receipt_id::text)), 'UTF8')), 'hex')
    AND r.response=jsonb_build_object('accountId',i.account_id::text,'receiptId',i.receipt_id::text,
      'requestedBy',i.requested_by::text,'kind',i.disposition,'reason',i.reason,
      'catalogueSubjectId',i.catalogue_id::text,'verificationReceiptId',i.verification_receipt_id::text)
    AND i.decided_by IS NOT DISTINCT FROM CASE WHEN i.disposition='revoked' THEN i.requested_by END
    AND ((r.command_kind='access.agent-verification.deleted' AND i.disposition='revoked'
       AND i.reason='Account deleted' AND i.requested_by=i.account_id
       AND r.request_digest=sha256(convert_to(i.account_id::text,'UTF8'))
       AND EXISTS (SELECT 1 FROM access.account t WHERE t.route=i.route AND t.account_id=i.account_id
         AND t.state='deleted'))
     OR (r.command_kind='access.agent-verification.'||i.disposition AND EXISTS (
       SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=r.partition_no
         AND b.transaction_id=r.transaction_id AND b.principal_kind='account' AND b.principal_id=r.principal_id
         AND b.epoch=r.epoch AND b.position=r.position)))
 );
$$;

CREATE OR REPLACE FUNCTION access.validate_agent_identity_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.minimized OR NEW.requested_by IS NULL OR
       (NOT EXISTS (SELECT 1 FROM core.receipt r
          WHERE r.partition_no=NEW.source_partition AND r.principal_kind='account'
            AND r.principal_id=NEW.requested_by AND r.command_kind=NEW.native_command_kind
            AND r.idempotency_key=NEW.native_receipt_key
            AND r.transaction_id=NEW.source_transaction_id AND r.epoch=NEW.source_epoch
            AND r.position=NEW.source_position AND r.xmin::text=pg_current_xact_id()::text)
        AND NOT access.agent_identity_recovery_valid(NEW)) THEN
        RAISE EXCEPTION 'Account identity intent lacks original same-command native receipt or verified native recovery' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION access.validate_agent_identity_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i access.agent_identity_intent;
BEGIN
    SELECT * INTO i FROM access.agent_identity_intent
      WHERE (route,account_id,direction,receipt_id)=(NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id);
    IF NOT access.agent_identity_recovery_valid(i) THEN
        RAISE EXCEPTION 'Account identity recovery lacks genuine original and actual recovery custody' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER agent_identity_recovery_native_commit AFTER INSERT ON access.agent_identity_recovery
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_agent_identity_recovery();
CREATE TRIGGER agent_identity_recovery_immutable BEFORE UPDATE OR DELETE ON access.agent_identity_recovery
 FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_intent();

-- migrate:down
-- Recovery associations cannot be silently discarded while original workflows can still use them.
DO $$ BEGIN RAISE EXCEPTION 'Agent identity recovery requires forward-only receiving custody'; END $$;
