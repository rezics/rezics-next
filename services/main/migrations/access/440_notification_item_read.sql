-- Individual reads coexist with the monotonic stream watermark. A recipient
-- cannot create a read marker for another recipient's item.
CREATE TABLE access.notification_item_read (
    principal_id uuid NOT NULL,
    item_id uuid NOT NULL,
    read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, item_id),
    FOREIGN KEY (item_id) REFERENCES access.notification_item(id)
);

CREATE FUNCTION access.guard_notification_item_read() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'notification item read is immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM access.notification_item i
        WHERE i.id = NEW.item_id AND i.principal_id = NEW.principal_id) THEN
        RAISE EXCEPTION 'notification item read belongs to its recipient' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_item_read_guard BEFORE INSERT OR UPDATE OR DELETE
    ON access.notification_item_read FOR EACH ROW EXECUTE FUNCTION access.guard_notification_item_read();
