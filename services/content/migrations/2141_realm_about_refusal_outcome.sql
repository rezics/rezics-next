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
