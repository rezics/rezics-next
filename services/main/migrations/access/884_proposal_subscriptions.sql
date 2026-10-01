CREATE TABLE access.proposal_subscription (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    proposal uuid NOT NULL REFERENCES access.editorial_proposal(id),
    reason text NOT NULL CHECK (reason IN ('author','reviewer','steward','manual')),
    level text NOT NULL CHECK (level IN ('participating','ignore')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (principal_id, proposal)
);
CREATE INDEX proposal_subscription_recipients ON access.proposal_subscription (proposal, principal_id);
CREATE FUNCTION access.guard_proposal_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'INSERT' AND NEW.revision <> 1 OR TG_OP = 'UPDATE' AND
        (NEW.principal_id <> OLD.principal_id OR NEW.proposal <> OLD.proposal OR NEW.reason <> OLD.reason
          OR NEW.revision <> OLD.revision + 1) THEN
        RAISE EXCEPTION 'subscription identity is stable and revision advances once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER proposal_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON access.proposal_subscription
    FOR EACH ROW EXECUTE FUNCTION access.guard_proposal_subscription();
CREATE FUNCTION access.subscribe_proposal_participant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'editorial_proposal' THEN
        INSERT INTO access.proposal_subscription (principal_id,proposal,reason,level)
            VALUES (NEW.proposer_principal,NEW.id,'author','participating') ON CONFLICT DO NOTHING;
    ELSE
        INSERT INTO access.proposal_subscription (principal_id,proposal,reason,level)
            VALUES (NEW.principal,NEW.proposal,'reviewer','participating') ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER proposal_author_subscription AFTER INSERT ON access.editorial_proposal
    FOR EACH ROW EXECUTE FUNCTION access.subscribe_proposal_participant();
CREATE TRIGGER proposal_reviewer_subscription AFTER INSERT ON access.editorial_review
    FOR EACH ROW EXECUTE FUNCTION access.subscribe_proposal_participant();
INSERT INTO access.proposal_subscription (principal_id,proposal,reason,level)
    SELECT proposer_principal,id,'author','participating' FROM access.editorial_proposal ON CONFLICT DO NOTHING;
INSERT INTO access.proposal_subscription (principal_id,proposal,reason,level)
    SELECT DISTINCT principal,proposal,'reviewer','participating' FROM access.editorial_review ON CONFLICT DO NOTHING;

CREATE TABLE access.notification_proposal_context (
    item_id uuid PRIMARY KEY REFERENCES access.notification_item(id),
    proposal uuid NOT NULL,
    revision integer NOT NULL,
    reason text NOT NULL CHECK (reason IN ('author','reviewer','steward','manual')),
    FOREIGN KEY (proposal, revision) REFERENCES access.editorial_revision(proposal,n)
);
CREATE TRIGGER notification_proposal_context_immutable BEFORE UPDATE OR DELETE ON access.notification_proposal_context
    FOR EACH ROW EXECUTE FUNCTION access.reject_notification_mutation();
ALTER TABLE access.notification_digest_candidate
    ADD COLUMN proposal uuid REFERENCES access.editorial_proposal(id),
    ADD COLUMN proposal_reason text CHECK (proposal_reason IN ('author','reviewer','steward','manual'));

-- This cursor consumes G-865's commit-serialized feed directly, including facts
-- written before this migration. No second event log or outbox is introduced.
INSERT INTO access.notification_producer_cursor (consumer) VALUES ('editorial-notification-v1') ON CONFLICT DO NOTHING;
