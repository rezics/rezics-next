-- One immutable pairing binds two existing history kinds and one shared receipt.
ALTER TABLE access.org_realm_receipt DROP CONSTRAINT org_realm_receipt_operation_check;
ALTER TABLE access.org_realm_receipt ADD CONSTRAINT org_realm_receipt_operation_check
    CHECK (operation IN ('propose', 'join', 'leave', 'suspend', 'lift-ban', 'move'));

CREATE TABLE access.org_realm_move (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    source_participation_id uuid NOT NULL,
    source_generation bigint NOT NULL CHECK (source_generation >= 2),
    target_participation_id uuid NOT NULL,
    target_generation bigint NOT NULL CHECK (target_generation >= 1),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (principal_id, idempotency_key),
    UNIQUE (source_participation_id, source_generation),
    UNIQUE (target_participation_id, target_generation),
    CHECK (source_participation_id <> target_participation_id),
    FOREIGN KEY (principal_id, idempotency_key)
        REFERENCES access.org_realm_receipt(principal_id, idempotency_key)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (source_participation_id, source_generation)
        REFERENCES access.org_realm_history(participation_id, generation),
    FOREIGN KEY (target_participation_id, target_generation)
        REFERENCES access.org_realm_history(participation_id, generation)
);
CREATE TRIGGER org_realm_move_immutable BEFORE UPDATE OR DELETE
    ON access.org_realm_move FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();

CREATE FUNCTION access.check_org_realm_move_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'org_realm_receipt' THEN
        IF NEW.operation <> 'move' THEN RETURN NEW; END IF;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM access.org_realm_move m
        JOIN access.org_realm_receipt r ON r.principal_id = m.principal_id
            AND r.idempotency_key = m.idempotency_key AND r.operation = 'move'
        JOIN access.org_realm_participation s ON s.id = m.source_participation_id
        JOIN access.org_realm_participation t ON t.id = m.target_participation_id
            AND t.realm <> s.realm AND t.organization_subject = s.organization_subject
        JOIN access.org_realm_history prior ON prior.participation_id = s.id
            AND prior.generation = m.source_generation - 1 AND prior.state = 'joined'
        JOIN access.org_realm_proposal_use su ON su.proposal_id = prior.proposal_id
            AND su.participation_id = prior.participation_id AND su.generation = prior.generation
        JOIN access.org_realm_history sh ON sh.participation_id = s.id
            AND sh.generation = m.source_generation AND sh.state = 'left' AND sh.action = 'leave'
            AND sh.proposal_id = prior.proposal_id AND sh.authority_epoch = m.authority_epoch
        JOIN access.org_realm_history th ON th.participation_id = t.id
            AND th.generation = m.target_generation AND th.state = 'joined' AND th.action = 'join'
            AND th.authority_epoch = m.authority_epoch AND th.actor_proof = sh.actor_proof
        JOIN access.org_realm_proposal_use tu ON tu.proposal_id = th.proposal_id
            AND tu.participation_id = t.id AND tu.generation = th.generation
        WHERE m.principal_id = NEW.principal_id AND m.idempotency_key = NEW.idempotency_key
            AND sh.actor_proof->>'principalId' = m.principal_id::text
            AND sh.actor_proof->>'subject' = s.organization_subject
            AND sh.actor_proof->>'action' = 'access.org-realm.participate'
            AND r.result->>'moveId' = m.id::text
            AND r.result->>'authorityEpoch' = m.authority_epoch::text
            AND r.result->'source'->>'participationId' = s.id::text
            AND r.result->'source'->>'generation' = sh.generation::text
            AND r.result->'source'->>'state' = 'left'
            AND r.result->'target'->>'participationId' = t.id::text
            AND r.result->'target'->>'generation' = th.generation::text
            AND r.result->'target'->>'state' = 'joined'
    ) THEN
        RAISE EXCEPTION 'Org/Realm move requires its exact paired histories and receipt' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER org_realm_move_pair AFTER INSERT ON access.org_realm_move
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.check_org_realm_move_pair();
CREATE CONSTRAINT TRIGGER org_realm_move_receipt AFTER INSERT ON access.org_realm_receipt
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.check_org_realm_move_pair();
