-- One rebuildable generation protocol for Main-owned derived read models:
-- ranking scores and event interval keys/histograms. Source owners remain
-- authoritative; these rows are reconstructable and never public truth.
-- A generation pins its input manifest and per-source {dataEpoch, sequence}
-- positions, is written only while building under its current lease epoch,
-- becomes immutable when ready, and is activated only by an exact-revision CAS
-- on its scope head. Positions compare only within one source epoch.
CREATE TABLE access.derived_generation_family (
    family text PRIMARY KEY CHECK (family ~ '^[a-z][a-z0-9-]{1,62}$'),
    -- Active plus superseded generations retained for cursor continuation.
    max_retained smallint NOT NULL CHECK (max_retained BETWEEN 2 AND 16),
    retain_for interval NOT NULL CHECK (retain_for BETWEEN interval '1 minute' AND interval '7 days')
);
INSERT INTO access.derived_generation_family (family, max_retained, retain_for)
VALUES ('ranking', 3, interval '1 hour'), ('event-interval', 3, interval '1 hour');

CREATE TABLE access.derived_generation (
    id uuid PRIMARY KEY,
    family text NOT NULL REFERENCES access.derived_generation_family(family),
    -- Digest of the declared view identity, e.g. population, Context and policy.
    scope_key text NOT NULL CHECK (scope_key ~ '^[0-9a-f]{64}$'),
    input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    input_manifest jsonb NOT NULL CHECK (jsonb_typeof(input_manifest) = 'object'
        AND octet_length(input_manifest::text) <= 16384),
    state text NOT NULL DEFAULT 'building'
        CHECK (state IN ('building', 'ready', 'failed', 'cancelled', 'superseded', 'expired')),
    lease_epoch bigint NOT NULL DEFAULT 1 CHECK (lease_epoch >= 1),
    lease_expires_at timestamptz,
    validation_digest text CHECK (validation_digest ~ '^[0-9a-f]{64}$'),
    failure_reason text CHECK (length(failure_reason) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ready_at timestamptz,
    finished_at timestamptz,
    UNIQUE (id, family),
    UNIQUE (id, family, scope_key),
    CONSTRAINT derived_generation_state_fields CHECK (
      (state = 'building' AND lease_expires_at IS NOT NULL AND validation_digest IS NULL
        AND failure_reason IS NULL AND ready_at IS NULL AND finished_at IS NULL)
      OR (state = 'ready' AND lease_expires_at IS NULL AND validation_digest IS NOT NULL
        AND failure_reason IS NULL AND ready_at IS NOT NULL AND finished_at IS NULL)
      OR (state = 'superseded' AND lease_expires_at IS NULL AND validation_digest IS NOT NULL
        AND failure_reason IS NULL AND ready_at IS NOT NULL AND finished_at IS NOT NULL)
      OR (state IN ('failed', 'cancelled') AND lease_expires_at IS NULL
        AND failure_reason IS NOT NULL AND finished_at IS NOT NULL)
      OR (state = 'expired' AND lease_expires_at IS NULL AND finished_at IS NOT NULL))
);
CREATE INDEX derived_generation_scope_recent ON access.derived_generation
    (family, scope_key, created_at DESC, id);
CREATE INDEX derived_generation_open_lease ON access.derived_generation (lease_expires_at, id)
    WHERE state = 'building';

-- One pinned input position and resumable checkpoint per source owner stream.
-- The effect rows and this checkpoint commit in one Access transaction.
CREATE TABLE access.derived_generation_input (
    generation_id uuid NOT NULL REFERENCES access.derived_generation(id) ON DELETE CASCADE,
    source text NOT NULL CONSTRAINT derived_generation_input_source
        CHECK (source IN ('main-graph', 'content', 'access')),
    data_epoch text NOT NULL CHECK (length(data_epoch) BETWEEN 1 AND 64),
    pinned_sequence numeric NOT NULL
        CHECK (pinned_sequence >= 0 AND pinned_sequence = trunc(pinned_sequence)),
    snapshot_cursor text CHECK (length(snapshot_cursor) BETWEEN 1 AND 512),
    snapshot_complete boolean NOT NULL DEFAULT false,
    checkpoint_sequence numeric NOT NULL
        CHECK (checkpoint_sequence >= pinned_sequence AND checkpoint_sequence = trunc(checkpoint_sequence)),
    checkpoint_event text CHECK (length(checkpoint_event) BETWEEN 1 AND 200),
    PRIMARY KEY (generation_id, source),
    CONSTRAINT derived_generation_input_snapshot CHECK (NOT snapshot_complete OR snapshot_cursor IS NULL)
);

CREATE TABLE access.derived_generation_head (
    family text NOT NULL,
    scope_key text NOT NULL,
    active_generation uuid NOT NULL UNIQUE,
    revision bigint NOT NULL CHECK (revision >= 1),
    activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (family, scope_key),
    FOREIGN KEY (active_generation, family, scope_key)
        REFERENCES access.derived_generation(id, family, scope_key)
);

-- Immutable head history, as other Access heads keep generation history.
CREATE TABLE access.derived_generation_activation (
    family text NOT NULL,
    scope_key text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 1),
    generation_id uuid NOT NULL UNIQUE,
    predecessor uuid REFERENCES access.derived_generation(id),
    lease_epoch bigint NOT NULL CHECK (lease_epoch >= 1),
    input_positions jsonb NOT NULL CHECK (jsonb_typeof(input_positions) = 'array'
        AND octet_length(input_positions::text) <= 4096),
    activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (family, scope_key, revision),
    FOREIGN KEY (generation_id, family, scope_key)
        REFERENCES access.derived_generation(id, family, scope_key),
    CHECK ((revision = 1) = (predecessor IS NULL)),
    CHECK (predecessor IS DISTINCT FROM generation_id)
);
CREATE INDEX derived_generation_activation_predecessor ON access.derived_generation_activation (predecessor)
    WHERE predecessor IS NOT NULL;

-- Build/activate/cancel replay, following the per-feature Access receipt pattern.
CREATE TABLE access.derived_generation_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN ('build', 'activate', 'cancel')),
    generation_id uuid NOT NULL REFERENCES access.derived_generation(id),
    outcome text NOT NULL CHECK (outcome IN ('succeeded', 'stale_head', 'rejected')),
    head_revision bigint CHECK (head_revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, idempotency_key),
    CONSTRAINT derived_generation_receipt_head CHECK (
      (action = 'activate' AND outcome = 'succeeded') = (head_revision IS NOT NULL))
);
CREATE INDEX derived_generation_receipt_generation ON access.derived_generation_receipt (generation_id);

CREATE FUNCTION access.reject_derived_generation_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable derived generation history' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER derived_generation_activation_immutable
    BEFORE UPDATE OR DELETE ON access.derived_generation_activation
    FOR EACH ROW EXECUTE FUNCTION access.reject_derived_generation_history_mutation();
CREATE TRIGGER derived_generation_receipt_immutable
    BEFORE UPDATE OR DELETE ON access.derived_generation_receipt
    FOR EACH ROW EXECUTE FUNCTION access.reject_derived_generation_history_mutation();

-- State machine. The active generation cannot leave ready; activation locks
-- the candidate row, so a concurrent failure or activation waits and rechecks.
CREATE FUNCTION access.derived_generation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.state IN ('building', 'ready') THEN
            RAISE EXCEPTION 'open derived generation cannot be deleted' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'building' OR NEW.lease_epoch <> 1 THEN
            RAISE EXCEPTION 'derived generation starts building at lease epoch 1' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.family, NEW.scope_key, NEW.input_digest, NEW.input_manifest, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.family, OLD.scope_key, OLD.input_digest, OLD.input_manifest, OLD.created_at) THEN
        RAISE EXCEPTION 'immutable derived generation identity' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_epoch < OLD.lease_epoch
       OR (NEW.lease_epoch <> OLD.lease_epoch AND (OLD.state <> 'building' OR NEW.state <> 'building')) THEN
        RAISE EXCEPTION 'derived generation lease epoch only advances while building' USING ERRCODE = '23514';
    END IF;
    IF NOT (OLD.state = NEW.state
        OR (OLD.state = 'building' AND NEW.state IN ('ready', 'failed', 'cancelled'))
        OR (OLD.state = 'ready' AND NEW.state IN ('superseded', 'failed', 'cancelled'))
        OR (OLD.state IN ('superseded', 'failed', 'cancelled') AND NEW.state = 'expired')) THEN
        RAISE EXCEPTION 'invalid derived generation transition % to %', OLD.state, NEW.state
            USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'ready' AND NEW.state <> 'ready' AND EXISTS (
        SELECT 1 FROM access.derived_generation_head WHERE active_generation = OLD.id) THEN
        RAISE EXCEPTION 'active derived generation cannot leave ready' USING ERRCODE = '23514';
    END IF;
    IF OLD.state IN ('ready', 'superseded') AND NEW.state IN ('ready', 'superseded')
       AND (NEW.validation_digest, NEW.ready_at) IS DISTINCT FROM (OLD.validation_digest, OLD.ready_at) THEN
        RAISE EXCEPTION 'immutable derived generation validation' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'building' AND NEW.state = 'ready' AND (
        NOT EXISTS (SELECT 1 FROM access.derived_generation_input WHERE generation_id = NEW.id)
        OR EXISTS (SELECT 1 FROM access.derived_generation_input
                   WHERE generation_id = NEW.id AND NOT snapshot_complete)) THEN
        RAISE EXCEPTION 'derived generation inputs are incomplete' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER derived_generation_guard
    BEFORE INSERT OR UPDATE OR DELETE ON access.derived_generation
    FOR EACH ROW EXECUTE FUNCTION access.derived_generation_guard();

CREATE FUNCTION access.derived_generation_input_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    generation_state text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    SELECT state INTO generation_state FROM access.derived_generation WHERE id = NEW.generation_id;
    IF generation_state IS DISTINCT FROM 'building' THEN
        RAISE EXCEPTION 'derived generation input changes only while building' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        (NEW.generation_id, NEW.source, NEW.data_epoch, NEW.pinned_sequence)
          IS DISTINCT FROM (OLD.generation_id, OLD.source, OLD.data_epoch, OLD.pinned_sequence)
        OR NEW.checkpoint_sequence < OLD.checkpoint_sequence
        OR (OLD.snapshot_complete AND NOT NEW.snapshot_complete)) THEN
        RAISE EXCEPTION 'derived generation input position cannot move back or change epoch'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER derived_generation_input_guard
    BEFORE INSERT OR UPDATE OR DELETE ON access.derived_generation_input
    FOR EACH ROW EXECUTE FUNCTION access.derived_generation_input_guard();

CREATE FUNCTION access.derived_generation_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    candidate_state text;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        (NEW.family, NEW.scope_key) IS DISTINCT FROM (OLD.family, OLD.scope_key)
        OR NEW.revision <> OLD.revision + 1
        OR NEW.active_generation = OLD.active_generation) THEN
        RAISE EXCEPTION 'derived generation head advances one revision to a new generation'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
        RAISE EXCEPTION 'derived generation head starts at revision 1' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO candidate_state FROM access.derived_generation
        WHERE id = NEW.active_generation FOR SHARE;
    IF candidate_state IS DISTINCT FROM 'ready' THEN
        RAISE EXCEPTION 'only a ready derived generation can be activated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER derived_generation_head_guard
    BEFORE INSERT OR UPDATE ON access.derived_generation_head
    FOR EACH ROW EXECUTE FUNCTION access.derived_generation_head_guard();

-- Shared statement guard for derived data tables with a generation_id column,
-- attached per event with a transition table named changed: rows change only
-- while their generation builds; deletion also serves terminal retention.
CREATE FUNCTION access.derived_rows_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM changed c JOIN access.derived_generation g ON g.id = c.generation_id
                   WHERE g.state = 'ready') THEN
            RAISE EXCEPTION 'ready derived generation rows are immutable' USING ERRCODE = '23514';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM changed c LEFT JOIN access.derived_generation g ON g.id = c.generation_id
                  WHERE g.state IS DISTINCT FROM 'building') THEN
        RAISE EXCEPTION 'derived generation rows change only while building' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
