-- Provider evidence can settle a delivery Access still records as pending, for
-- example after an Access restore that predates the send. Terminal outcomes stay
-- final; this only widens the open-state transitions of 063.
CREATE OR REPLACE FUNCTION access.guard_notification_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification delivery is terminal, not deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'pending' OR NEW.attempt_count <> 0 OR NOT EXISTS (
            SELECT 1 FROM access.notification_item i JOIN access.notification_endpoint e
                ON e.id = NEW.endpoint_id AND e.principal_id = i.principal_id
            WHERE i.id = NEW.item_id AND i.principal_id = NEW.principal_id AND i.state = 'active'
              AND e.state = 'active' AND e.channel = NEW.channel AND e.generation = NEW.endpoint_generation) THEN
            RAISE EXCEPTION 'notification delivery starts pending for an active item and endpoint'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.item_id, NEW.principal_id, NEW.endpoint_id, NEW.channel, NEW.endpoint_generation,
        NEW.expires_at, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.item_id, OLD.principal_id,
        OLD.endpoint_id, OLD.channel, OLD.endpoint_generation, OLD.expires_at, OLD.created_at)
        OR OLD.state IN ('delivered', 'failed', 'cancelled')
        OR NEW.attempt_count < OLD.attempt_count
        OR NOT ((OLD.state = 'pending' AND NEW.state IN ('pending', 'sending', 'delivered', 'failed', 'cancelled'))
             OR (OLD.state = 'sending' AND NEW.state IN ('pending', 'uncertain', 'delivered', 'failed', 'cancelled'))
             OR (OLD.state = 'uncertain' AND NEW.state IN ('uncertain', 'sending', 'delivered', 'failed', 'cancelled'))) THEN
        RAISE EXCEPTION 'notification delivery transition is not allowed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
