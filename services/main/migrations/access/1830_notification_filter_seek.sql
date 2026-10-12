-- A read index over the existing triage and proposal owners. Flags and reasons
-- still belong to those records; their transaction maintains this seek row.
CREATE TABLE access.notification_filter_seek (
    item_id uuid PRIMARY KEY REFERENCES access.notification_item(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    generation bigint NOT NULL,
    sequence bigint NOT NULL,
    saved boolean NOT NULL DEFAULT false,
    done boolean NOT NULL DEFAULT false,
    reason text CHECK (reason IN ('author', 'reviewer', 'steward', 'manual'))
);

CREATE FUNCTION access.sync_notification_filter_seek() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'notification_item' THEN
        INSERT INTO access.notification_filter_seek (item_id, principal_id, generation, sequence)
            VALUES (NEW.id, NEW.principal_id, NEW.generation, NEW.sequence);
    ELSIF TG_TABLE_NAME = 'notification_item_triage' THEN
        UPDATE access.notification_filter_seek SET saved = NEW.saved, done = NEW.done
            WHERE item_id = NEW.item_id AND principal_id = NEW.principal_id;
    ELSE
        UPDATE access.notification_filter_seek SET reason = NEW.reason WHERE item_id = NEW.item_id;
    END IF;
    RETURN NEW;
END $$;

-- Install the source triggers before copying existing rows. Their DDL locks
-- keep a concurrent source write from escaping the copy within this migration.
CREATE TRIGGER notification_item_filter_seek AFTER INSERT ON access.notification_item
    FOR EACH ROW EXECUTE FUNCTION access.sync_notification_filter_seek();
CREATE TRIGGER notification_triage_filter_seek AFTER INSERT OR UPDATE ON access.notification_item_triage
    FOR EACH ROW EXECUTE FUNCTION access.sync_notification_filter_seek();
CREATE TRIGGER notification_reason_filter_seek AFTER INSERT ON access.notification_proposal_context
    FOR EACH ROW EXECUTE FUNCTION access.sync_notification_filter_seek();

INSERT INTO access.notification_filter_seek (item_id, principal_id, generation, sequence, saved, done, reason)
    SELECT i.id, i.principal_id, i.generation, i.sequence, coalesce(t.saved, false), coalesce(t.done, false), c.reason
    FROM access.notification_item i
    LEFT JOIN access.notification_item_triage t ON t.item_id = i.id AND t.principal_id = i.principal_id
    LEFT JOIN access.notification_proposal_context c ON c.item_id = i.id;

-- Literal view predicates let PostgreSQL seek within a partial index instead
-- of examining unrelated history. A reason is another leading equality key.
CREATE INDEX notification_filter_inbox ON access.notification_filter_seek (principal_id, generation, sequence)
    WHERE NOT done;
CREATE INDEX notification_filter_saved ON access.notification_filter_seek (principal_id, generation, sequence)
    WHERE saved;
CREATE INDEX notification_filter_done ON access.notification_filter_seek (principal_id, generation, sequence)
    WHERE done;
CREATE INDEX notification_filter_inbox_reason ON access.notification_filter_seek (principal_id, generation, reason, sequence)
    WHERE NOT done;
CREATE INDEX notification_filter_saved_reason ON access.notification_filter_seek (principal_id, generation, reason, sequence)
    WHERE saved;
CREATE INDEX notification_filter_done_reason ON access.notification_filter_seek (principal_id, generation, reason, sequence)
    WHERE done;
