-- Capture committed Access owner facts without changing their writers. The
-- counter row serializes append commits, so a cursor cannot skip a late commit.
-- Row locks last through transaction end: https://www.postgresql.org/docs/18/explicit-locking.html
CREATE TABLE access.notification_producer_head (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    position bigint NOT NULL DEFAULT 0 CHECK (position >= 0)
);
INSERT INTO access.notification_producer_head (id) VALUES (true);

CREATE TABLE access.notification_producer_event (
    position bigint PRIMARY KEY CHECK (position > 0),
    kind text NOT NULL CHECK (kind IN ('submission_decision', 'moderation_outcome',
        'realm_role_change', 'realm_membership_change')),
    event_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (kind, event_id)
);
CREATE TABLE access.notification_producer_cursor (
    consumer text PRIMARY KEY CHECK (length(consumer) BETWEEN 1 AND 128),
    position bigint NOT NULL DEFAULT 0 CHECK (position >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- G-287's impact lists permission differences. A role rename or assignment
-- change can affect a member without changing effective permissions. Capture
-- the exact members touched inside the owner's transaction before its receipt.
-- txid_current() is a per-transaction bigint: https://www.postgresql.org/docs/18/functions-info.html
CREATE TABLE access.notification_realm_pending (
    transaction_id bigint NOT NULL,
    realm text NOT NULL,
    member text NOT NULL,
    PRIMARY KEY (transaction_id, realm, member)
);
CREATE TABLE access.notification_realm_effect (
    receipt_id uuid NOT NULL REFERENCES access.realm_admin_receipt(id),
    member text NOT NULL,
    PRIMARY KEY (receipt_id, member)
);
CREATE FUNCTION access.capture_notification_role_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO access.notification_realm_pending (transaction_id, realm, member)
      VALUES (txid_current(), NEW.realm, NEW.member) ON CONFLICT DO NOTHING;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_role_assignment AFTER INSERT OR UPDATE ON access.realm_admin_assignment
    FOR EACH ROW EXECUTE FUNCTION access.capture_notification_role_assignment();
CREATE FUNCTION access.capture_notification_role_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO access.notification_realm_pending (transaction_id, realm, member)
      SELECT txid_current(), NEW.realm, a.member FROM access.realm_admin_assignment a
      WHERE a.realm = NEW.realm AND a.role_id = NEW.id AND a.valid_until > clock_timestamp()
      ON CONFLICT DO NOTHING;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_role_definition AFTER INSERT OR UPDATE ON access.realm_admin_role
    FOR EACH ROW EXECUTE FUNCTION access.capture_notification_role_definition();

CREATE FUNCTION access.append_notification_producer_event(_kind text, _event uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE _position bigint;
BEGIN
    UPDATE access.notification_producer_head SET position = position + 1
      WHERE id RETURNING position INTO _position;
    INSERT INTO access.notification_producer_event (position, kind, event_id)
      VALUES (_position, _kind, _event);
END $$;

CREATE FUNCTION access.notify_submission_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state IN ('accepted', 'rejected', 'changes-requested')
       AND NEW.state IS DISTINCT FROM OLD.state THEN
        PERFORM access.append_notification_producer_event('submission_decision', NEW.revision);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_submission_decision AFTER UPDATE ON access.realm_submission
    FOR EACH ROW EXECUTE FUNCTION access.notify_submission_decision();

CREATE FUNCTION access.notify_moderation_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.case_id IS NOT NULL THEN
        PERFORM access.append_notification_producer_event('moderation_outcome', NEW.id);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_moderation_outcome AFTER INSERT ON access.moderation_decision
    FOR EACH ROW EXECUTE FUNCTION access.notify_moderation_outcome();

CREATE FUNCTION access.notify_realm_management() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.action = 'realm.roles.manage' THEN
        INSERT INTO access.notification_realm_effect (receipt_id, member)
          SELECT NEW.id, member FROM access.notification_realm_pending
          WHERE transaction_id = txid_current() AND realm = NEW.realm;
        DELETE FROM access.notification_realm_pending WHERE transaction_id = txid_current();
        PERFORM access.append_notification_producer_event('realm_role_change', NEW.id);
    ELSIF NEW.action = 'realm.members.manage' THEN
        PERFORM access.append_notification_producer_event('realm_membership_change', NEW.id);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_realm_management AFTER INSERT ON access.realm_admin_receipt
    FOR EACH ROW EXECUTE FUNCTION access.notify_realm_management();
