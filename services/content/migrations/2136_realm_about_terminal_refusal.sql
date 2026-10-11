-- A composite refusal stops future dispatch without cancelling or erasing
-- successful draft/identity effects owned elsewhere. The operation row lock
-- orders this decision with dispatch; recorded admissions retain graph recovery.
ALTER TABLE content.realm_about_post_operation
    ADD COLUMN terminal_refusal boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT realm_about_terminal_before_dispatch CHECK (
        NOT terminal_refusal OR placement_admission_id IS NULL AND phase <> 'posted'
    );

CREATE FUNCTION content.guard_realm_about_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.terminal_refusal AND NEW IS DISTINCT FROM OLD
        OR NEW.terminal_refusal AND
            (to_jsonb(NEW) - 'terminal_refusal') IS DISTINCT FROM (to_jsonb(OLD) - 'terminal_refusal')
    THEN RAISE EXCEPTION 'refused discussion intent is retained without further effects' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_about_terminal_guard BEFORE UPDATE ON content.realm_about_post_operation
    FOR EACH ROW EXECUTE FUNCTION content.guard_realm_about_terminal();

CREATE OR REPLACE FUNCTION content.guard_reply_about_selection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent content.realm_about_post_operation;
BEGIN
    SELECT * INTO intent FROM content.realm_about_post_operation WHERE reply = NEW.id FOR UPDATE;
    IF FOUND AND (intent.terminal_refusal OR intent.phase <> 'drafted' OR NEW.context_revision IS NOT NULL
        OR (NEW.variant_id, NEW.author, NEW.root_target, NEW.root_revision, NEW.origin_realm,
            NEW.parent_reply, NEW.parent_revision)
        IS DISTINCT FROM (intent.variant_id, intent.actor, intent.about, intent.root_revision,
            intent.realm, intent.parent_reply, intent.parent_revision)
        OR NOT EXISTS (SELECT 1 FROM content.receipt r WHERE r.operation_id = NEW.operation_id
            AND r.revision_id = intent.revision_id AND r.outcome = 'succeeded')
    ) THEN RAISE EXCEPTION 'reply differs from reserved discussion selection' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;
