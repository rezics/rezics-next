-- migrate:up
CREATE TABLE access.agent_identity_intent (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL CHECK (direction IN ('account-agent.verify','account-agent.unverify')),
    receipt_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    account_kind text NOT NULL CHECK (account_kind IN ('actor','organization')),
    catalogue_id uuid NOT NULL,
    request_id uuid,
    requested_by uuid,
    decided_by uuid,
    decision_route integer,
    decision_receipt_id uuid,
    decision_epoch integer,
    decision_position bigint,
    decision_transaction_id uuid,
    pending_receipt_id uuid NOT NULL,
    verification_receipt_id uuid,
    disposition text CHECK (disposition IN ('released','revoked')),
    reason text CHECK (char_length(reason)<=500),
    release text NOT NULL,
    intent jsonb NOT NULL,
    intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL CHECK (source_epoch>0),
    source_position bigint NOT NULL CHECK (source_position>0),
    source_transaction_id uuid NOT NULL,
    undo_job_id uuid,
    undo_job_epoch bigint,
    delivery_key text NOT NULL,
    workflow_id text NOT NULL,
    native_command_kind text NOT NULL,
    native_receipt_key text NOT NULL,
    CHECK ((direction='account-agent.verify' AND native_command_kind='access.agent-verification.pending')
        OR (direction='account-agent.unverify' AND native_command_kind IN
          ('access.agent-verification.released','access.agent-verification.revoked','access.agent-verification.deleted'))),
    minimized boolean NOT NULL DEFAULT false,
    PRIMARY KEY(route,account_id,direction,receipt_id),
    CHECK (route = get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
    CHECK (source_partition = route / 16),
    CHECK ((direction='account-agent.verify' AND request_id IS NOT NULL AND decision_route=0
            AND decision_receipt_id=receipt_id AND decision_epoch>0 AND decision_position>0
            AND decision_transaction_id=receipt_id AND verification_receipt_id IS NULL
            AND undo_job_id IS NULL AND undo_job_epoch IS NULL AND disposition IS NULL)
        OR (direction='account-agent.unverify' AND verification_receipt_id IS NOT NULL
            AND source_transaction_id=receipt_id AND disposition IS NOT NULL
            AND undo_job_id IS NOT NULL AND undo_job_epoch>0)),
    CHECK (direction<>'account-agent.verify' OR source_transaction_id=pending_receipt_id)
);
CREATE INDEX erasure_agent_identity_intent_account_id ON access.agent_identity_intent
    (account_id,route,direction,receipt_id);
CREATE INDEX erasure_agent_identity_intent_requested_by ON access.agent_identity_intent
    (requested_by,route,account_id,direction,receipt_id);
CREATE INDEX erasure_agent_identity_intent_decided_by ON access.agent_identity_intent
    (decided_by,route,account_id,direction,receipt_id);

CREATE FUNCTION access.validate_agent_identity_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.minimized OR NEW.requested_by IS NULL OR
       NOT EXISTS (SELECT 1 FROM core.receipt r
          WHERE r.partition_no=NEW.source_partition AND r.principal_kind='account'
            AND r.principal_id=NEW.requested_by AND r.command_kind=NEW.native_command_kind
            AND r.idempotency_key=NEW.native_receipt_key
            AND r.transaction_id=NEW.source_transaction_id AND r.epoch=NEW.source_epoch
            AND r.position=NEW.source_position AND r.xmin::text=pg_current_xact_id()::text) THEN
        RAISE EXCEPTION 'Account identity intent lacks original same-command native receipt' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER agent_identity_intent_native_commit AFTER INSERT ON access.agent_identity_intent
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_agent_identity_intent();

-- Keep source proof until a consumer-aware owner minimizer supplies receiving custody.
CREATE FUNCTION access.guard_agent_identity_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'Account identity source requires receiving erasure custody';
    END IF;
    RAISE EXCEPTION 'Immutable account identity source';
END;
$$;
CREATE TRIGGER agent_identity_intent_immutable BEFORE UPDATE OR DELETE ON access.agent_identity_intent
    FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_intent();

-- migrate:down
DROP TABLE access.agent_identity_intent;
DROP FUNCTION access.guard_agent_identity_intent();
DROP FUNCTION access.validate_agent_identity_intent();
