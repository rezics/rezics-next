-- Legacy rows share xid zero so their old positions remain their exact order.
-- The DDL lock drains old appenders before the function and cursors change.
ALTER TABLE access.notification_producer_event RENAME COLUMN position TO id;
ALTER TABLE access.notification_producer_event
    ADD COLUMN epoch bigint,
    ADD COLUMN xid xid8 NOT NULL DEFAULT '0'::xid8;
UPDATE access.notification_producer_event
    SET epoch = (SELECT generation FROM access.recovery_fence WHERE id);
ALTER TABLE access.notification_producer_event
    ALTER COLUMN epoch SET NOT NULL,
    ALTER COLUMN xid SET DEFAULT pg_current_xact_id(),
    ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(pg_get_serial_sequence('access.notification_producer_event', 'id'),
    COALESCE(max(id), 1), max(id) IS NOT NULL) FROM access.notification_producer_event;
CREATE INDEX notification_producer_event_order ON access.notification_producer_event (epoch, xid, id);

-- position still belongs to the independent editorial log. Access log consumers
-- resume after their old position, including a cursor ahead of all retained rows.
ALTER TABLE access.notification_producer_cursor
    ADD COLUMN epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    ADD COLUMN xid xid8 NOT NULL DEFAULT '0'::xid8,
    ADD COLUMN id bigint NOT NULL DEFAULT 0 CHECK (id >= 0);
UPDATE access.notification_producer_cursor
    SET epoch = (SELECT generation FROM access.recovery_fence WHERE id), id = position
    WHERE consumer <> 'editorial-notification-v1';

-- Recovery release advances generation before writers reopen. That epoch must
-- lead xid: pg_dump preserves rows but not the cluster's transaction counter.
CREATE OR REPLACE FUNCTION access.append_notification_producer_event(_kind text, _event uuid)
RETURNS void LANGUAGE sql AS $$
    INSERT INTO access.notification_producer_event (epoch, kind, event_id)
        SELECT generation, _kind, _event FROM access.recovery_fence WHERE id;
$$;
DROP TABLE access.notification_producer_head;
