-- IAM18 keeps three owners and effects apart. A mute is the principal's private
-- presentation preference for feed/search selection. A block is the recipient
-- Agent's interaction admission rule for messages, replies and mentions. Resource
-- exclusion remains an access.policy rule. None of them implies another.
CREATE TABLE access.interaction_mute_preference (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    target_kind text NOT NULL CHECK (target_kind IN ('realm', 'agent')),
    target text NOT NULL CHECK (target ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    match text NOT NULL,
    muted boolean NOT NULL,
    revision uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, target_kind, target, match),
    CONSTRAINT interaction_mute_explicit_match CHECK (
        (target_kind = 'realm'
            AND match IN ('publishing-realm', 'author-membership', 'publication-context'))
        OR (target_kind = 'agent' AND match = 'author'))
);

-- Each recipient's blocks live under its own `interaction:<Agent>` scope gate, so
-- a block change advances that existing authority epoch rather than a new one.
CREATE TABLE access.interaction_block (
    id uuid PRIMARY KEY,
    recipient_subject text NOT NULL REFERENCES access.authority_subject(id),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    target_kind text NOT NULL CHECK (target_kind IN ('agent', 'member-set')),
    target_subject text REFERENCES access.authority_subject(id),
    set_kind text,
    set_owner_subject text,
    basis text CHECK (basis IN ('authenticated_principal', 'acting_subject')),
    interactions text[] NOT NULL CHECK (cardinality(interactions) BETWEEN 1 AND 3
        AND array_position(interactions, NULL) IS NULL
        AND interactions <@ ARRAY['message', 'reply', 'mention']::text[]),
    set_by_principal uuid NOT NULL REFERENCES access.principal(id),
    set_by_representation_id uuid NOT NULL REFERENCES access.representation(id),
    set_by_representation_generation bigint NOT NULL
        CHECK (set_by_representation_generation >= 0),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (set_kind, set_owner_subject)
        REFERENCES access.membership_policy(kind, owner_subject),
    CONSTRAINT interaction_block_scope CHECK (scope_id = 'interaction:' || recipient_subject),
    CONSTRAINT interaction_block_target CHECK (
        (target_kind = 'agent' AND target_subject IS NOT NULL
            AND target_subject <> recipient_subject AND set_kind IS NULL
            AND set_owner_subject IS NULL AND basis IS NULL)
        OR (target_kind = 'member-set' AND target_subject IS NULL AND set_kind IS NOT NULL
            AND set_owner_subject IS NOT NULL AND basis IS NOT NULL))
);
CREATE UNIQUE INDEX interaction_block_live_agent ON access.interaction_block
    (recipient_subject, target_subject) WHERE active AND target_kind = 'agent';
CREATE UNIQUE INDEX interaction_block_live_set ON access.interaction_block
    (recipient_subject, set_kind, set_owner_subject, basis)
    WHERE active AND target_kind = 'member-set';
CREATE INDEX interaction_block_recipient_active ON access.interaction_block
    (recipient_subject, id) WHERE active;

CREATE FUNCTION access.keep_interaction_block_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.recipient_subject, NEW.scope_id, NEW.target_kind, NEW.target_subject,
        NEW.set_kind, NEW.set_owner_subject, NEW.basis, NEW.interactions,
        NEW.set_by_principal, NEW.set_by_representation_id,
        NEW.set_by_representation_generation, NEW.created_at)
        IS DISTINCT FROM
       (OLD.id, OLD.recipient_subject, OLD.scope_id, OLD.target_kind, OLD.target_subject,
        OLD.set_kind, OLD.set_owner_subject, OLD.basis, OLD.interactions,
        OLD.set_by_principal, OLD.set_by_representation_id,
        OLD.set_by_representation_generation, OLD.created_at)
        OR (NOT OLD.active AND NEW.active) THEN
        RAISE EXCEPTION 'interaction block episode is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER interaction_block_episode BEFORE UPDATE
    ON access.interaction_block FOR EACH ROW
    EXECUTE FUNCTION access.keep_interaction_block_episode();
CREATE TRIGGER interaction_block_generation_advance BEFORE UPDATE
    ON access.interaction_block FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();
CREATE TRIGGER interaction_block_retained BEFORE DELETE
    ON access.interaction_block FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();

-- Mute replay returns its preference revision; block replay returns the block
-- and the recipient interaction scope epoch.
CREATE TABLE access.interaction_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN ('mute', 'unmute', 'block', 'unblock')),
    mute_revision uuid,
    block_id uuid REFERENCES access.interaction_block(id),
    result_authority_epoch bigint CHECK (result_authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key),
    CHECK ((action IN ('mute', 'unmute') AND mute_revision IS NOT NULL
            AND block_id IS NULL AND result_authority_epoch IS NULL)
        OR (action IN ('block', 'unblock') AND mute_revision IS NULL
            AND block_id IS NOT NULL AND result_authority_epoch IS NOT NULL))
);
CREATE TRIGGER interaction_change_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.interaction_change_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();
