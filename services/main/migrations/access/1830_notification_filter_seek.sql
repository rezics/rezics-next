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
DECLARE
    item uuid;
BEGIN
    IF TG_TABLE_NAME = 'notification_item' THEN
        item := NEW.id;
    ELSE
        item := NEW.item_id;
    END IF;
    INSERT INTO access.notification_filter_seek AS seek (item_id, principal_id, generation, sequence, saved, done, reason)
        SELECT i.id, i.principal_id, i.generation, i.sequence, coalesce(t.saved, false), coalesce(t.done, false), c.reason
        FROM access.notification_item i
        LEFT JOIN access.notification_item_triage t ON t.item_id = i.id AND t.principal_id = i.principal_id
        LEFT JOIN access.notification_proposal_context c ON c.item_id = i.id
        WHERE i.id = item
        ON CONFLICT (item_id) DO UPDATE SET saved = EXCLUDED.saved, done = EXCLUDED.done, reason = EXCLUDED.reason
        WHERE (seek.saved, seek.done, seek.reason) IS DISTINCT FROM (EXCLUDED.saved, EXCLUDED.done, EXCLUDED.reason);
    RETURN NEW;
END $$;

-- Install the source triggers before copying existing rows. Their DDL locks
-- keep a concurrent source write from escaping the copy within this migration.
-- Materialize the final owner state once at commit. Intermediate default Inbox
-- membership would otherwise leave dead index tuples for every newly Done item,
-- making a filtered read scan unrelated history until the next vacuum.
CREATE CONSTRAINT TRIGGER notification_item_filter_seek AFTER INSERT ON access.notification_item
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION access.sync_notification_filter_seek();
CREATE CONSTRAINT TRIGGER notification_triage_filter_seek AFTER INSERT OR UPDATE ON access.notification_item_triage
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION access.sync_notification_filter_seek();
CREATE CONSTRAINT TRIGGER notification_reason_filter_seek AFTER INSERT ON access.notification_proposal_context
    DEFERRABLE INITIALLY DEFERRED
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
