-- Version 1 is the text account_subject representation understood by this Main.
-- A later format switch is an explicit offline operation, never an auto migration.
CREATE TABLE access.storage_format (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    version integer NOT NULL CHECK (version > 0),
    state text NOT NULL CHECK (state IN ('ready', 'upgrade-pending')),
    target_version integer,
    CHECK ((state = 'ready' AND target_version IS NULL)
        OR (state = 'upgrade-pending' AND target_version >= version))
);
INSERT INTO access.storage_format (id, version, state) VALUES (true, 1, 'ready');

CREATE FUNCTION access.require_compatible_format_on_reopen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE format_record access.storage_format%ROWTYPE;
DECLARE subject_type text;
BEGIN
    IF NEW.open AND NOT OLD.open THEN
        SELECT * INTO format_record FROM access.storage_format WHERE id = true;
        SELECT data_type INTO subject_type FROM information_schema.columns
          WHERE table_schema = 'access' AND table_name = 'principal'
            AND column_name = 'account_subject';
        IF format_record.version IS DISTINCT FROM 1
            OR format_record.state IS DISTINCT FROM 'ready'
            OR subject_type IS DISTINCT FROM 'text' THEN
            RAISE EXCEPTION 'Access storage format is incompatible with this runtime';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER recovery_fence_format_guard BEFORE UPDATE OF open
ON access.recovery_fence FOR EACH ROW
EXECUTE FUNCTION access.require_compatible_format_on_reopen();
