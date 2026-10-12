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

-- Live extrema keep retired index entries outside a read's seek range. The
-- empty reason key covers the whole view; named reasons refine that same view.
CREATE TABLE access.notification_filter_bounds (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    generation bigint NOT NULL,
    view text NOT NULL CHECK (view IN ('inbox', 'saved', 'done')),
    reason text NOT NULL CHECK (reason IN ('', 'author', 'reviewer', 'steward', 'manual')),
    lower_sequence bigint,
    upper_sequence bigint,
    synchronized_xid xid8 NOT NULL,
    PRIMARY KEY (principal_id, generation, view, reason),
    CHECK ((lower_sequence IS NULL) = (upper_sequence IS NULL)),
    CHECK (lower_sequence > 0 AND upper_sequence >= lower_sequence)
);

CREATE FUNCTION access.refresh_notification_filter_bounds(recipient uuid, stream_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM access.notification_filter_bounds
        WHERE principal_id = recipient AND generation = stream_generation AND view = 'inbox' AND reason = ''
            AND synchronized_xid = pg_current_xact_id()) THEN RETURN; END IF;
    -- Deferred source callbacks see the final triage/context state. Refresh all
    -- buckets once, so a bulk commit never creates one metadata version per item.
    -- The caller holds the projection fence; this write scans one recipient's
    -- generation, while reads use only its two exact cached extrema.
    WITH membership AS (
        SELECT i.sequence, v.view, r.reason FROM access.notification_item i
        LEFT JOIN access.notification_item_triage t ON t.item_id = i.id AND t.principal_id = i.principal_id
        LEFT JOIN access.notification_proposal_context c ON c.item_id = i.id
        CROSS JOIN LATERAL (VALUES ('inbox', NOT coalesce(t.done, false)), ('saved', coalesce(t.saved, false)), ('done', coalesce(t.done, false))) v(view, member)
        CROSS JOIN LATERAL (SELECT '' AS reason UNION SELECT c.reason WHERE c.reason IS NOT NULL) r
        WHERE i.principal_id = recipient AND i.generation = stream_generation AND i.stream = 'inbox' AND v.member
    ), extrema AS MATERIALIZED (
        SELECT view, reason, min(sequence) AS lower_sequence, max(sequence) AS upper_sequence
        FROM membership GROUP BY view, reason
    )
    INSERT INTO access.notification_filter_bounds (principal_id, generation, view, reason, lower_sequence, upper_sequence, synchronized_xid)
        SELECT recipient, stream_generation, v.view, r.reason, e.lower_sequence, e.upper_sequence, pg_current_xact_id()
        FROM unnest(ARRAY['inbox', 'saved', 'done']) v(view)
        CROSS JOIN unnest(ARRAY['', 'author', 'reviewer', 'steward', 'manual']) r(reason)
        LEFT JOIN extrema e ON e.view = v.view AND e.reason = r.reason
        ON CONFLICT (principal_id, generation, view, reason) DO UPDATE
        SET lower_sequence = EXCLUDED.lower_sequence, upper_sequence = EXCLUDED.upper_sequence,
            synchronized_xid = EXCLUDED.synchronized_xid;
END $$;

CREATE FUNCTION access.sync_notification_filter_seek() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    item uuid;
    recipient uuid;
    stream_generation bigint;
BEGIN
    IF TG_TABLE_NAME = 'notification_item' THEN
        item := NEW.id;
    ELSE
        item := NEW.item_id;
    END IF;
    SELECT principal_id, generation INTO recipient, stream_generation FROM access.notification_item WHERE id = item;
    -- All affected view/reason extrema share one deterministic owner fence.
    -- Acquire it before touching seek rows, including no-op trigger replays.
    PERFORM pg_advisory_xact_lock(hashtextextended('notification-filter:' || recipient::text || ':' || stream_generation::text, 0));
    INSERT INTO access.notification_filter_seek AS seek (item_id, principal_id, generation, sequence, saved, done, reason)
        SELECT i.id, i.principal_id, i.generation, i.sequence, coalesce(t.saved, false), coalesce(t.done, false), c.reason
        FROM access.notification_item i
        LEFT JOIN access.notification_item_triage t ON t.item_id = i.id AND t.principal_id = i.principal_id
        LEFT JOIN access.notification_proposal_context c ON c.item_id = i.id
        WHERE i.id = item
        ON CONFLICT (item_id) DO UPDATE SET saved = EXCLUDED.saved, done = EXCLUDED.done, reason = EXCLUDED.reason
        WHERE (seek.saved, seek.done, seek.reason) IS DISTINCT FROM (EXCLUDED.saved, EXCLUDED.done, EXCLUDED.reason);
    IF NOT FOUND THEN RETURN NEW; END IF;
    PERFORM access.refresh_notification_filter_bounds(recipient, stream_generation);
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

DO $$ DECLARE recipient record; BEGIN
    FOR recipient IN SELECT DISTINCT principal_id, generation FROM access.notification_filter_seek LOOP
        PERFORM access.refresh_notification_filter_bounds(recipient.principal_id, recipient.generation);
    END LOOP;
END $$;

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
