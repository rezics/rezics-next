-- Ending a semantic restriction retains its identity, head, immutable revisions,
-- rules, references, decision frames and receipts. A later revision can govern
-- the same scope again; ending is not a new (empty, still governing) revision.
ALTER TABLE access.policy ADD COLUMN ended_at timestamptz;

CREATE OR REPLACE FUNCTION access.keep_policy_head_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
        OR NEW.owner_subject IS DISTINCT FROM OLD.owner_subject
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NOT ((NEW.head_revision = OLD.head_revision + 1 AND NEW.ended_at IS NULL)
            OR (NEW.head_revision = OLD.head_revision AND OLD.ended_at IS NULL
                AND NEW.ended_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'policy identity is immutable; publish advances its head, end retains it'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- Widen the latest receipt checks (040), preserving all three existing actions
-- and the existing revision foreign key. End receipts name the retained head.
ALTER TABLE access.policy_change_receipt DROP CONSTRAINT policy_change_receipt_action_check;
ALTER TABLE access.policy_change_receipt ADD CONSTRAINT policy_change_receipt_action_check
    CHECK (action IN ('publish-revision', 'end-policy', 'admit-set', 'revoke-set'));
ALTER TABLE access.policy_change_receipt DROP CONSTRAINT policy_change_receipt_check;
ALTER TABLE access.policy_change_receipt ADD CONSTRAINT policy_change_receipt_check
    CHECK ((action IN ('publish-revision', 'end-policy') AND policy_id IS NOT NULL
            AND policy_revision IS NOT NULL AND set_admission_id IS NULL)
        OR (action IN ('admit-set', 'revoke-set') AND policy_id IS NULL
            AND policy_revision IS NULL AND set_admission_id IS NOT NULL));
