-- Triage belongs to one recipient/item and never changes its read marker.
CREATE TABLE access.notification_item_triage (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    item_id uuid NOT NULL REFERENCES access.notification_item(id),
    saved boolean NOT NULL DEFAULT false,
    done boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (principal_id, item_id)
);
CREATE FUNCTION access.guard_notification_triage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NOT EXISTS (SELECT 1 FROM access.notification_item
        WHERE id = NEW.item_id AND principal_id = NEW.principal_id) THEN
        RAISE EXCEPTION 'triage belongs to the item recipient' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.revision <> 1 OR TG_OP = 'UPDATE' AND
        (NEW.principal_id <> OLD.principal_id OR NEW.item_id <> OLD.item_id OR NEW.revision <> OLD.revision + 1) THEN
        RAISE EXCEPTION 'triage revision must advance once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_triage_guard BEFORE INSERT OR UPDATE OR DELETE ON access.notification_item_triage
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_triage();
