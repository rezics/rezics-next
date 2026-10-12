-- Preserve the native error identity so the existing HTTP adapter can replay
-- exactly. A placement cancellation is terminal without being pre-dispatch.
ALTER TABLE content.realm_about_post_operation ADD COLUMN terminal_outcome jsonb;

CREATE OR REPLACE FUNCTION content.guard_realm_about_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.terminal_refusal AND
        (to_jsonb(NEW) - 'terminal_outcome') IS DISTINCT FROM (to_jsonb(OLD) - 'terminal_outcome')
        OR NEW.terminal_refusal AND
        (to_jsonb(NEW) - ARRAY['terminal_refusal','terminal_outcome']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['terminal_refusal','terminal_outcome'])
        OR OLD.terminal_outcome IS NOT NULL AND NEW IS DISTINCT FROM OLD
    THEN RAISE EXCEPTION 'refused discussion intent is retained without further effects' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION content.guard_realm_about_post_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical content.realm_about_thread;
BEGIN
    -- Refusal retention changes no selection or owner effect. The
    -- historical canonical key may already have been released or replaced.
    IF TG_OP = 'UPDATE' AND
        (to_jsonb(NEW) - ARRAY['terminal_outcome','terminal_refusal']) IS NOT DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['terminal_outcome','terminal_refusal'])
    THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'discussion intent progress is retained' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        (NEW.id, NEW.actor, NEW.intent_key, NEW.intent_digest, NEW.requested_root_revision, NEW.realm, NEW.about,
         NEW.reply, NEW.variant_id, NEW.opener_reply, NEW.root_revision, NEW.parent_reply, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.actor, OLD.intent_key, OLD.intent_digest, OLD.requested_root_revision, OLD.realm, OLD.about,
         OLD.reply, OLD.variant_id, OLD.opener_reply, OLD.root_revision, OLD.parent_reply, OLD.created_at)
        OR array_position(ARRAY['selected','drafted','identified','posted'], NEW.phase)
            < array_position(ARRAY['selected','drafted','identified','posted'], OLD.phase)
        OR OLD.parent_revision IS NOT NULL AND NEW.parent_revision IS DISTINCT FROM OLD.parent_revision
        OR OLD.revision_id IS NOT NULL AND NEW.revision_id IS DISTINCT FROM OLD.revision_id
        OR OLD.draft_operation_id IS NOT NULL AND NEW.draft_operation_id IS DISTINCT FROM OLD.draft_operation_id
        OR OLD.identity_operation_id IS NOT NULL AND NEW.identity_operation_id IS DISTINCT FROM OLD.identity_operation_id
        OR OLD.placement_operation_id IS NOT NULL AND NEW.placement_operation_id IS DISTINCT FROM OLD.placement_operation_id
        OR OLD.placement_receipt IS NOT NULL AND NEW.placement_receipt IS DISTINCT FROM OLD.placement_receipt
    ) THEN RAISE EXCEPTION 'discussion intent selection and effects are immutable' USING ERRCODE = '23514'; END IF;
    SELECT * INTO canonical FROM content.realm_about_thread
        WHERE realm = NEW.realm AND about = NEW.about;
    IF NOT FOUND OR NEW.root_revision <> canonical.root_revision
        OR NEW.opener_reply <> canonical.opener_reply
        OR NEW.parent_revision IS NOT NULL AND (
            canonical.state <> 'active' OR NEW.parent_revision IS DISTINCT FROM canonical.revision_id
        ) THEN RAISE EXCEPTION 'discussion selection differs from canonical key' USING ERRCODE = '23514'; END IF;
    IF NEW.phase <> 'selected' AND NOT EXISTS (
        SELECT 1 FROM content.receipt r JOIN content.revision v
            ON v.id = r.revision_id AND v.variant_id = r.variant_id
        JOIN content.reply_author a ON a.reply = NEW.reply AND a.variant_id = v.variant_id
        WHERE r.operation_id = NEW.draft_operation_id AND r.action = 'draft.save' AND r.outcome = 'succeeded'
          AND r.variant_id = NEW.variant_id AND r.revision_id = NEW.revision_id
          AND a.operation_id = r.operation_id
          AND a.author = NEW.actor AND a.root_target = NEW.about
          AND a.root_revision = NEW.root_revision AND a.origin_realm = NEW.realm
    ) THEN RAISE EXCEPTION 'discussion draft progress lacks its owner receipt' USING ERRCODE = '23514'; END IF;
    IF NEW.phase IN ('identified','posted') AND NOT EXISTS (
        SELECT 1 FROM content.reply p JOIN content.receipt r ON r.operation_id = p.operation_id
        WHERE p.id = NEW.reply AND p.operation_id = NEW.identity_operation_id
          AND r.revision_id = NEW.revision_id AND r.outcome = 'succeeded'
    ) THEN RAISE EXCEPTION 'discussion identity progress lacks its owner receipt' USING ERRCODE = '23514'; END IF;
    IF NEW.phase = 'posted' AND NOT EXISTS (
        SELECT 1 FROM content.realm_placement_preparation p
        WHERE p.operation_id = NEW.placement_operation_id AND p.realm = NEW.realm
          AND p.variant_id = NEW.variant_id AND p.revision_id = NEW.revision_id
    ) THEN RAISE EXCEPTION 'discussion placement differs from preparation' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;

-- Previously returned generic refusals have no more specific retained proof.
UPDATE content.realm_about_post_operation
    SET terminal_outcome='{"kind":"reply-stale","message":"Discussion intent was refused before placement"}'::jsonb
    WHERE terminal_refusal;

ALTER TABLE content.realm_about_post_operation
    ADD CONSTRAINT realm_about_terminal_outcome CHECK (
        (NOT terminal_refusal OR terminal_outcome IS NOT NULL)
        AND (terminal_outcome IS NULL OR COALESCE(
            phase <> 'posted'
            AND jsonb_typeof(terminal_outcome)='object'
            AND terminal_outcome - ARRAY['kind','message']='{}'::jsonb
            AND jsonb_typeof(terminal_outcome->'message')='string'
            AND length(terminal_outcome->>'message') <= 8192
            AND terminal_outcome->>'kind' IN (
                'reply-denied','reply-invalid','reply-stale','admission-denied',
                'draft-denied','draft-rights-denied','draft-stale','content-conflict',
                'target-not-bound','target-unavailable','read-missing','read-moved','read-invalid'
            ), false))
    );
