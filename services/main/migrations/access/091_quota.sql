-- Domain quota admission, metering and compensation (SUB04). Rate limits,
-- metering and commercial charging keep their own identities; this owner only
-- admits bounded units. Reservations may name the Access admission they serve
-- and reuse access.recovery_fence; ledgers funded by an entitlement reference
-- commerce.entitlement, so gifted and purchased capacity stay independent.
CREATE SCHEMA quota;

CREATE FUNCTION quota.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable quota record in %', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

-- One policy per scope (a Realm or other native owner) and unit. Revisions are
-- immutable; a ledger keeps the revision it was opened under.
CREATE TABLE quota.policy (
    id uuid PRIMARY KEY,
    scope text NOT NULL CHECK (scope ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    unit text NOT NULL CHECK (unit ~ '^[a-z][a-z0-9.-]{0,62}$'),
    head_revision bigint NOT NULL CHECK (head_revision >= 1),
    UNIQUE (scope, unit)
);
CREATE TABLE quota.policy_revision (
    policy_id uuid NOT NULL REFERENCES quota.policy(id),
    revision bigint NOT NULL CHECK (revision >= 1),
    period text NOT NULL CHECK (period IN ('P1D', 'P1M', 'none')),
    base_allowance bigint NOT NULL CHECK (base_allowance >= 0),
    max_reservation bigint NOT NULL CHECK (max_reservation > 0),
    reservation_ttl interval NOT NULL
        CHECK (reservation_ttl >= interval '1 second' AND reservation_ttl <= interval '1 day'),
    -- What cancellation or failure does with the unconsumed remainder.
    failure_policy text NOT NULL CHECK (failure_policy IN ('release', 'retain')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (policy_id, revision)
);
ALTER TABLE quota.policy ADD CONSTRAINT policy_head_revision_fk
    FOREIGN KEY (id, head_revision) REFERENCES quota.policy_revision(policy_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

-- One capacity account per policy, beneficiary, funding source and period.
-- The CHECK is the last-capacity guard: reservations update this row, so two
-- concurrent final-capacity requests serialize and cannot both overspend.
CREATE TABLE quota.ledger (
    id uuid PRIMARY KEY,
    policy_id uuid NOT NULL,
    policy_revision bigint NOT NULL,
    beneficiary text NOT NULL CHECK (beneficiary ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    source text NOT NULL CHECK (source IN ('base', 'entitlement')),
    entitlement_id uuid REFERENCES commerce.entitlement(id),
    period_start timestamptz NOT NULL,
    period_end timestamptz,
    capacity bigint NOT NULL CHECK (capacity >= 0),
    reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    consumed bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
    -- Closing (period end, entitlement end/revocation) stops new reservations;
    -- consumed usage and live reservations stay accounted.
    open boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES quota.policy_revision(policy_id, revision),
    CHECK ((source = 'entitlement') = (entitlement_id IS NOT NULL)),
    CHECK (period_end IS NULL OR period_end > period_start),
    CHECK (reserved + consumed <= capacity)
);
CREATE UNIQUE INDEX ledger_base_period ON quota.ledger (policy_id, beneficiary, period_start)
    WHERE source = 'base';
CREATE UNIQUE INDEX ledger_entitlement_period ON quota.ledger (policy_id, entitlement_id, period_start)
    WHERE source = 'entitlement';
CREATE INDEX ledger_open_beneficiary ON quota.ledger (beneficiary, policy_id, period_start)
    WHERE open;
CREATE INDEX ledger_policy_revision_fk ON quota.ledger (policy_id, policy_revision);
CREATE INDEX ledger_entitlement_fk ON quota.ledger (entitlement_id) WHERE entitlement_id IS NOT NULL;

-- A reservation holds a bounded maximum for one operation stage. Retry reuses
-- it by (policy, operation, stage); changed intent conflicts on request_digest.
-- reconciling is an unknown external outcome: it cannot expire and settles
-- only through reconciliation. Terminal states never reopen.
CREATE TABLE quota.reservation (
    id uuid PRIMARY KEY,
    ledger_id uuid NOT NULL REFERENCES quota.ledger(id),
    policy_id uuid NOT NULL,
    policy_revision bigint NOT NULL,
    operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 200),
    stage integer NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 10000),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    admission_id uuid REFERENCES access.admission(id),
    amount bigint NOT NULL CHECK (amount > 0),
    consumed bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
    state text NOT NULL CHECK (state IN ('reserved', 'reconciling', 'settled', 'released', 'expired')),
    generation bigint NOT NULL CHECK (generation >= 1),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (policy_id, operation_id, stage),
    FOREIGN KEY (policy_id, policy_revision) REFERENCES quota.policy_revision(policy_id, revision),
    CHECK (consumed <= amount),
    CHECK (expires_at > created_at)
);
CREATE INDEX reservation_ledger ON quota.reservation (ledger_id, id);
CREATE INDEX reservation_expiry ON quota.reservation (expires_at, id) WHERE state = 'reserved';
CREATE INDEX reservation_reconciling ON quota.reservation (created_at, id) WHERE state = 'reconciling';
CREATE INDEX reservation_admission_fk ON quota.reservation (admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX reservation_policy_revision_fk ON quota.reservation (policy_id, policy_revision);

-- Immutable reservation history. A worker ACK or provider callback identity is
-- recorded once per reservation, so duplicate ACKs cannot consume twice.
CREATE TABLE quota.reservation_event (
    reservation_id uuid NOT NULL REFERENCES quota.reservation(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    action text NOT NULL CHECK (action IN ('reserve', 'renew', 'consume', 'defer',
        'settle', 'release', 'expire')),
    state text NOT NULL CHECK (state IN ('reserved', 'reconciling', 'settled', 'released', 'expired')),
    consumed bigint NOT NULL CHECK (consumed >= 0),
    expires_at timestamptz NOT NULL,
    ack_reference text CHECK (length(ack_reference) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (reservation_id, generation),
    CHECK ((generation = 1) = (action = 'reserve'))
);
CREATE UNIQUE INDEX reservation_event_ack ON quota.reservation_event (reservation_id, ack_reference)
    WHERE ack_reference IS NOT NULL;
ALTER TABLE quota.reservation ADD CONSTRAINT reservation_head_event_fk
    FOREIGN KEY (id, generation) REFERENCES quota.reservation_event(reservation_id, generation)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION quota.guard_policy_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'quota policy cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.head_revision <> 1 THEN
            RAISE EXCEPTION 'quota policy starts at revision one' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.scope, NEW.unit) IS DISTINCT FROM (OLD.id, OLD.scope, OLD.unit)
        OR NEW.head_revision <> OLD.head_revision + 1 THEN
        RAISE EXCEPTION 'quota policy identity or revision changed illegally' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER policy_head_guard BEFORE INSERT OR UPDATE OR DELETE ON quota.policy
    FOR EACH ROW EXECUTE FUNCTION quota.guard_policy_head();

-- Ledger totals move only through reservation transitions (maintained below)
-- and the one-way close. Identity, capacity and period never change.
CREATE FUNCTION quota.guard_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'quota ledger cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.reserved <> 0 OR NEW.consumed <> 0 OR NOT NEW.open THEN
            RAISE EXCEPTION 'quota ledger starts open and empty' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.policy_id, NEW.policy_revision, NEW.beneficiary, NEW.source, NEW.entitlement_id,
        NEW.period_start, NEW.period_end, NEW.capacity, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.policy_id, OLD.policy_revision, OLD.beneficiary, OLD.source,
        OLD.entitlement_id, OLD.period_start, OLD.period_end, OLD.capacity, OLD.created_at)
        OR (NEW.open AND NOT OLD.open) OR NEW.consumed < OLD.consumed THEN
        RAISE EXCEPTION 'quota ledger identity, capacity or usage changed illegally' USING ERRCODE = '23514';
    END IF;
    -- Only the reservation trigger (one level deeper) may move the totals.
    IF (NEW.reserved, NEW.consumed) IS DISTINCT FROM (OLD.reserved, OLD.consumed)
        AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'quota ledger totals move only through reservations' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON quota.ledger
    FOR EACH ROW EXECUTE FUNCTION quota.guard_ledger();

CREATE FUNCTION quota.guard_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    ledger_policy uuid;
    ledger_revision bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'quota reservation cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT policy_id, policy_revision INTO ledger_policy, ledger_revision
        FROM quota.ledger WHERE id = NEW.ledger_id;
        IF NEW.generation <> 1 OR NEW.state <> 'reserved' OR NEW.consumed <> 0
            OR (ledger_policy, ledger_revision) IS DISTINCT FROM (NEW.policy_id, NEW.policy_revision) THEN
            RAISE EXCEPTION 'quota reservation must start reserved on its ledger policy revision'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.ledger_id, NEW.policy_id, NEW.policy_revision, NEW.operation_id, NEW.stage,
        NEW.request_digest, NEW.admission_id, NEW.amount, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.ledger_id, OLD.policy_id, OLD.policy_revision, OLD.operation_id,
        OLD.stage, OLD.request_digest, OLD.admission_id, OLD.amount, OLD.created_at)
        OR NEW.generation <> OLD.generation + 1
        OR NEW.consumed < OLD.consumed
        OR OLD.state IN ('settled', 'released', 'expired')
        OR (OLD.state = 'reconciling' AND NEW.state NOT IN ('reconciling', 'settled', 'released'))
        OR (NEW.state = 'reserved' AND OLD.state <> 'reserved')
        OR (NEW.state = 'expired' AND clock_timestamp() < OLD.expires_at)
        OR (NEW.state = OLD.state AND NEW.expires_at < OLD.expires_at) THEN
        RAISE EXCEPTION 'quota reservation identity changed or illegal transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON quota.reservation
    FOR EACH ROW EXECUTE FUNCTION quota.guard_reservation();

-- The same statement that reserves or terminates also moves its ledger row:
-- a closed ledger or exhausted capacity rejects the reservation atomically,
-- and a terminal state releases the remainder while keeping consumed usage.
CREATE FUNCTION quota.apply_reservation_to_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE quota.ledger SET reserved = reserved + NEW.amount
        WHERE id = NEW.ledger_id AND open;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'quota ledger is closed' USING ERRCODE = '23514';
        END IF;
    ELSIF OLD.state IN ('reserved', 'reconciling')
        AND NEW.state IN ('settled', 'released', 'expired') THEN
        UPDATE quota.ledger SET reserved = reserved - NEW.amount, consumed = consumed + NEW.consumed
        WHERE id = NEW.ledger_id;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER reservation_ledger_totals AFTER INSERT OR UPDATE ON quota.reservation
    FOR EACH ROW EXECUTE FUNCTION quota.apply_reservation_to_ledger();

CREATE TRIGGER policy_revision_immutable BEFORE UPDATE OR DELETE ON quota.policy_revision
    FOR EACH ROW EXECUTE FUNCTION quota.reject_mutation();
CREATE TRIGGER reservation_event_immutable BEFORE UPDATE OR DELETE ON quota.reservation_event
    FOR EACH ROW EXECUTE FUNCTION quota.reject_mutation();
