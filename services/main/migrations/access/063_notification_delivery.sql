-- External channel delivery. The committed delivery row is the bounded work
-- item itself: workers lease due rows, recheck eligibility and disclosure, and
-- use the stable delivery id as the provider idempotency key. This is distinct
-- from the relay's internal graph-event delivery and adds no second outbox.
CREATE TABLE access.notification_delivery (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES access.notification_item(id),
    principal_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('email', 'push')),
    endpoint_generation bigint NOT NULL CHECK (endpoint_generation >= 1),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN
        ('pending', 'sending', 'uncertain', 'delivered', 'failed', 'cancelled')),
    cancel_reason text CHECK (cancel_reason IN ('unsubscribed', 'ineligible', 'undisclosed',
        'endpoint_invalid', 'recipient_erased', 'subject_erased', 'expired')),
    attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 16),
    next_attempt_at timestamptz,
    lease_token uuid,
    lease_until timestamptz,
    expires_at timestamptz NOT NULL,
    provider_message_id text CHECK (provider_message_id IS NULL
        OR length(provider_message_id) BETWEEN 1 AND 256),
    diagnostic text CHECK (diagnostic IS NULL OR (length(diagnostic) BETWEEN 1 AND 500
        AND diagnostic !~ '[[:cntrl:]]')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    terminal_at timestamptz,
    UNIQUE (item_id, endpoint_id),
    FOREIGN KEY (endpoint_id, principal_id) REFERENCES access.notification_endpoint(id, principal_id),
    CHECK ((state IN ('delivered', 'failed', 'cancelled')) = (terminal_at IS NOT NULL)),
    CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),
    CHECK ((state = 'sending') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
    CHECK ((state IN ('pending', 'uncertain')) = (next_attempt_at IS NOT NULL))
);
-- Bounded worker scans: due work, expired leases, recipient erasure fan-out.
CREATE INDEX notification_delivery_due ON access.notification_delivery (next_attempt_at, id)
    WHERE state IN ('pending', 'uncertain');
CREATE INDEX notification_delivery_lease ON access.notification_delivery (lease_until, id)
    WHERE state = 'sending';
CREATE INDEX notification_delivery_open_recipient ON access.notification_delivery (principal_id, id)
    WHERE state IN ('pending', 'sending', 'uncertain');
CREATE INDEX notification_delivery_endpoint_fk ON access.notification_delivery (endpoint_id, principal_id);

-- Terminal outcomes are final: unsubscribe, rotation or a late callback cannot
-- reactivate a cancelled, failed or delivered row.
CREATE FUNCTION access.guard_notification_delivery() RETURNS trigger
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
        OR NOT ((OLD.state = 'pending' AND NEW.state IN ('pending', 'sending', 'cancelled'))
             OR (OLD.state = 'sending' AND NEW.state IN ('pending', 'uncertain', 'delivered', 'failed', 'cancelled'))
             OR (OLD.state = 'uncertain' AND NEW.state IN ('uncertain', 'sending', 'delivered', 'failed', 'cancelled'))) THEN
        RAISE EXCEPTION 'notification delivery transition is not allowed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_guard BEFORE INSERT OR UPDATE OR DELETE
    ON access.notification_delivery
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_delivery();

-- One row per provider call under a lease. Uncertain is an explicit outcome to
-- reconcile, never a guessed success or failure. Diagnostics are bounded and safe.
CREATE TABLE access.notification_attempt (
    delivery_id uuid NOT NULL REFERENCES access.notification_delivery(id),
    attempt smallint NOT NULL CHECK (attempt BETWEEN 1 AND 16),
    lease_token uuid NOT NULL,
    address_digest text NOT NULL CHECK (address_digest ~ '^[0-9a-f]{64}$'),
    disclosure_digest text NOT NULL CHECK (disclosure_digest ~ '^[0-9a-f]{64}$'),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    outcome text CHECK (outcome IN ('accepted', 'rejected_permanent', 'rejected_transient', 'uncertain')),
    provider_status text CHECK (provider_status IS NULL OR provider_status ~ '^[A-Za-z0-9_.:-]{1,64}$'),
    provider_message_id text CHECK (provider_message_id IS NULL
        OR length(provider_message_id) BETWEEN 1 AND 256),
    diagnostic text CHECK (diagnostic IS NULL OR (length(diagnostic) BETWEEN 1 AND 500
        AND diagnostic !~ '[[:cntrl:]]')),
    finished_at timestamptz,
    PRIMARY KEY (delivery_id, attempt),
    CHECK ((outcome IS NULL) = (finished_at IS NULL))
);

CREATE FUNCTION access.guard_notification_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.outcome IS NOT NULL
        OR (NEW.delivery_id, NEW.attempt, NEW.lease_token, NEW.address_digest, NEW.disclosure_digest,
            NEW.started_at) IS DISTINCT FROM (OLD.delivery_id, OLD.attempt, OLD.lease_token,
            OLD.address_digest, OLD.disclosure_digest, OLD.started_at) THEN
        RAISE EXCEPTION 'notification attempt is finished once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_attempt_guard BEFORE UPDATE OR DELETE ON access.notification_attempt
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_attempt();

-- Provider callbacks and reconciliation lookups deduplicate by provider event id.
-- An unmatched callback is retained without a delivery rather than guessed.
CREATE TABLE access.notification_provider_event (
    provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 256),
    delivery_id uuid REFERENCES access.notification_delivery(id),
    source text NOT NULL CHECK (source IN ('callback', 'reconciliation')),
    kind text NOT NULL CHECK (kind IN ('delivered', 'bounced', 'complained', 'failed', 'suppressed', 'not_found')),
    payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider, provider_event_id)
);
CREATE INDEX notification_provider_event_delivery ON access.notification_provider_event (delivery_id, received_at)
    WHERE delivery_id IS NOT NULL;
CREATE TRIGGER notification_provider_event_immutable BEFORE UPDATE OR DELETE
    ON access.notification_provider_event
    FOR EACH ROW EXECUTE FUNCTION access.reject_notification_mutation();
