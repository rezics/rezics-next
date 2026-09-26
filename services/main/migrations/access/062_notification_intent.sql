-- Private notification control and recipient inbox state. Preferences cover only
-- optional purposes; security and account messages follow their own purpose
-- contract. An inbox item references its source event and exact subject; it
-- stores no rendered copy, so delivery re-renders only currently disclosed fields.
CREATE FUNCTION access.reject_notification_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable notification record' USING ERRCODE = '23514';
END $$;

CREATE TABLE access.notification_preference (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    purpose text NOT NULL CHECK (purpose IN ('social', 'subscription', 'governance')),
    topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    channel text NOT NULL CHECK (channel IN ('inbox', 'email', 'push')),
    state text NOT NULL CHECK (state IN ('enabled', 'disabled')),
    revision bigint NOT NULL CHECK (revision >= 1),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, purpose, topic, channel)
);

-- Immutable preference history and idempotent receipt. Signed unsubscribe and
-- provider suppression are attributable changes, not silent deletes.
CREATE TABLE access.notification_preference_change (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    purpose text NOT NULL,
    topic text NOT NULL,
    channel text NOT NULL,
    state text NOT NULL CHECK (state IN ('enabled', 'disabled')),
    revision bigint NOT NULL CHECK (revision >= 1),
    via text NOT NULL CHECK (via IN ('settings', 'signed_link', 'provider_suppression')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, idempotency_key),
    UNIQUE (principal_id, purpose, topic, channel, revision),
    FOREIGN KEY (principal_id, purpose, topic, channel)
        REFERENCES access.notification_preference(principal_id, purpose, topic, channel)
);
CREATE TRIGGER notification_preference_change_immutable BEFORE UPDATE OR DELETE
    ON access.notification_preference_change
    FOR EACH ROW EXECUTE FUNCTION access.reject_notification_mutation();

CREATE FUNCTION access.guard_notification_preference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification preference changes are recorded, not deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.revision <> 1 THEN
            RAISE EXCEPTION 'notification preference starts at revision one' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.principal_id <> OLD.principal_id OR NEW.purpose <> OLD.purpose OR NEW.topic <> OLD.topic
        OR NEW.channel <> OLD.channel OR NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'notification preference must advance by one revision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_preference_guard BEFORE INSERT OR UPDATE OR DELETE
    ON access.notification_preference
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_preference();

-- Private per-device or per-address endpoint generation. Email addresses stay
-- Account-owned (only their digest is kept); push tokens stay here, never in RDF.
CREATE TABLE access.notification_endpoint (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    channel text NOT NULL CHECK (channel IN ('email', 'push')),
    device_id text CHECK (device_id IS NULL OR device_id ~ '^[A-Za-z0-9:_./-]{1,128}$'),
    generation bigint NOT NULL CHECK (generation >= 1),
    state text NOT NULL CHECK (state IN ('active', 'retired', 'invalid')),
    address text CHECK (address IS NULL OR length(address) BETWEEN 1 AND 2048),
    address_digest text NOT NULL CHECK (address_digest ~ '^[0-9a-f]{64}$'),
    lock_screen_disclosure boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    retired_at timestamptz,
    UNIQUE (id, principal_id),
    CHECK ((channel = 'email') = (device_id IS NULL)),
    CHECK (channel <> 'email' OR address IS NULL),
    CHECK (channel <> 'push' OR state <> 'active' OR address IS NOT NULL),
    CHECK ((state = 'active') = (retired_at IS NULL))
);
CREATE UNIQUE INDEX notification_endpoint_active ON access.notification_endpoint
    (principal_id, channel, device_id) NULLS NOT DISTINCT WHERE state = 'active';
CREATE UNIQUE INDEX notification_endpoint_generation ON access.notification_endpoint
    (principal_id, channel, device_id, generation) NULLS NOT DISTINCT;

-- Rotation or invalidation retires a generation; a retired endpoint cannot return.
CREATE FUNCTION access.guard_notification_endpoint() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification endpoint is retired, not deleted' USING ERRCODE = '23514';
    END IF;
    IF NEW.id <> OLD.id OR NEW.principal_id <> OLD.principal_id OR NEW.channel <> OLD.channel
        OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.generation <> OLD.generation
        OR NEW.address_digest <> OLD.address_digest OR OLD.state <> 'active'
        OR (NEW.address IS NOT NULL AND NEW.address IS DISTINCT FROM OLD.address) THEN
        RAISE EXCEPTION 'notification endpoint generation is immutable once retired' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_endpoint_guard BEFORE UPDATE OR DELETE ON access.notification_endpoint
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_endpoint();

-- One ordered stream per recipient and declared stream name. A reset opens a new
-- generation; sequences never move backward within a generation.
CREATE TABLE access.notification_stream (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    stream text NOT NULL CHECK (stream IN ('inbox')),
    generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
    head_sequence bigint NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
    reset_at timestamptz,
    PRIMARY KEY (principal_id, stream)
);

CREATE FUNCTION access.guard_notification_stream() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification stream cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.generation <> 1 OR NEW.head_sequence <> 0 OR NEW.reset_at IS NOT NULL THEN
            RAISE EXCEPTION 'notification stream starts empty at generation one' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.principal_id <> OLD.principal_id OR NEW.stream <> OLD.stream
        OR NOT ((NEW.generation = OLD.generation AND NEW.head_sequence >= OLD.head_sequence
                 AND NEW.reset_at IS NOT DISTINCT FROM OLD.reset_at)
             OR (NEW.generation = OLD.generation + 1 AND NEW.head_sequence = 0 AND NEW.reset_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'notification stream is monotonic within a generation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_stream_guard BEFORE INSERT OR UPDATE OR DELETE ON access.notification_stream
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_stream();

-- Recipient-specific notification intent and inbox identity. Duplicate source
-- events collapse by (recipient, source event, topic).
CREATE TABLE access.notification_item (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL,
    stream text NOT NULL,
    generation bigint NOT NULL CHECK (generation >= 1),
    sequence bigint NOT NULL CHECK (sequence >= 1),
    purpose text NOT NULL CHECK (purpose IN ('security', 'account', 'social', 'subscription', 'governance')),
    topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    source_owner text NOT NULL CHECK (source_owner IN ('graph', 'content', 'access', 'account')),
    source_event text NOT NULL CHECK (length(source_event) BETWEEN 1 AND 256),
    subject_owner text NOT NULL CHECK (subject_owner IN ('graph', 'content', 'source', 'media', 'access')),
    subject_ref text NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 512),
    subject_revision text CHECK (subject_revision IS NULL OR length(subject_revision) BETWEEN 1 AND 512),
    disclosure_basis text NOT NULL CHECK (length(disclosure_basis) BETWEEN 1 AND 256),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'withdrawn', 'erased')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    state_changed_at timestamptz,
    FOREIGN KEY (principal_id, stream) REFERENCES access.notification_stream(principal_id, stream),
    UNIQUE (principal_id, stream, generation, sequence),
    UNIQUE (principal_id, source_owner, source_event, topic),
    CHECK ((state = 'active') = (state_changed_at IS NULL))
);
-- Erasure/withdrawal fan-out by exact subject.
CREATE INDEX notification_item_subject ON access.notification_item (subject_owner, subject_ref, id)
    WHERE state = 'active';

CREATE FUNCTION access.guard_notification_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification item is withdrawn or erased, not deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM access.notification_stream s
            WHERE s.principal_id = NEW.principal_id AND s.stream = NEW.stream
              AND s.generation = NEW.generation AND s.head_sequence >= NEW.sequence) THEN
            RAISE EXCEPTION 'notification item must be inside its advanced stream head' USING ERRCODE = '23514';
        END IF;
        IF NEW.state <> 'active' THEN
            RAISE EXCEPTION 'notification item starts active' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.principal_id, NEW.stream, NEW.generation, NEW.sequence, NEW.purpose, NEW.topic,
        NEW.source_owner, NEW.source_event, NEW.subject_owner, NEW.subject_ref, NEW.disclosure_basis,
        NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.principal_id, OLD.stream, OLD.generation,
        OLD.sequence, OLD.purpose, OLD.topic, OLD.source_owner, OLD.source_event, OLD.subject_owner,
        OLD.subject_ref, OLD.disclosure_basis, OLD.created_at)
        OR NEW.subject_revision IS DISTINCT FROM OLD.subject_revision
        OR NOT ((OLD.state = 'active' AND NEW.state IN ('withdrawn', 'erased'))
             OR (OLD.state = 'withdrawn' AND NEW.state = 'erased')) THEN
        RAISE EXCEPTION 'notification item can only be withdrawn or erased' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_item_guard BEFORE INSERT OR UPDATE OR DELETE ON access.notification_item
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_item();

-- Recipient read watermark per stream generation, independent of per-device
-- delivery and of source/conversation read state. Idempotent and monotonic.
CREATE TABLE access.notification_read_watermark (
    principal_id uuid NOT NULL,
    stream text NOT NULL,
    generation bigint NOT NULL CHECK (generation >= 1),
    read_through bigint NOT NULL CHECK (read_through >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, stream, generation),
    FOREIGN KEY (principal_id, stream) REFERENCES access.notification_stream(principal_id, stream)
);

CREATE FUNCTION access.guard_notification_read_watermark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'notification read watermark cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.principal_id <> OLD.principal_id OR NEW.stream <> OLD.stream
        OR NEW.generation <> OLD.generation OR NEW.read_through < OLD.read_through) THEN
        RAISE EXCEPTION 'notification read watermark is monotonic' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM access.notification_stream s
        WHERE s.principal_id = NEW.principal_id AND s.stream = NEW.stream
          AND (s.generation > NEW.generation
            OR (s.generation = NEW.generation AND s.head_sequence >= NEW.read_through))) THEN
        RAISE EXCEPTION 'notification read watermark is beyond its stream head' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_read_watermark_guard BEFORE INSERT OR UPDATE OR DELETE
    ON access.notification_read_watermark
    FOR EACH ROW EXECUTE FUNCTION access.guard_notification_read_watermark();
