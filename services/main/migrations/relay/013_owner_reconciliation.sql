-- Owner reconciliation compares restored, upgraded, moved or crashed owner cuts
-- with the retained frontier: the recovery coverage head generation, the erasure
-- journal epoch and relay checkpoints/batches. It is retained outside restored
-- owners and records per-owner cut status and per-item dispositions. A missing
-- committed revision is unavailable, never current-head substitution; an unused
-- newer body is newer_unadopted, never adopted. Holds stay until reconciled.
CREATE TABLE relay.owner_reconciliation (
    id uuid PRIMARY KEY,
    operation_id text NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 1 AND 200),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    kind text NOT NULL CHECK (kind IN ('restore', 'format_upgrade', 'anchor_rebuild',
        'revision_recovery', 'relay_gap', 'consumer_redelivery', 'retention_gc',
        'relocation', 'erasure')),
    scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 300),
    consumer text REFERENCES relay.checkpoint(consumer),
    coverage_generation bigint CHECK (coverage_generation >= 1),
    erasure_epoch bigint REFERENCES relay.erasure(erasure_epoch),
    relocation_id uuid REFERENCES relay.owner_relocation(id),
    erasure_id uuid REFERENCES relay.erasure(id),
    format_from text CHECK (length(format_from) BETWEEN 1 AND 100),
    format_to text CHECK (length(format_to) BETWEEN 1 AND 100),
    state text NOT NULL DEFAULT 'running'
        CHECK (state IN ('running', 'held', 'reconciled', 'failed')),
    hold_reason text CHECK (length(hold_reason) BETWEEN 1 AND 500),
    outcome_digest text CHECK (outcome_digest ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    CHECK ((kind = 'relocation') = (relocation_id IS NOT NULL)),
    CHECK ((kind = 'erasure') = (erasure_id IS NOT NULL)),
    CHECK ((kind = 'format_upgrade') = (format_from IS NOT NULL AND format_to IS NOT NULL)),
    CHECK (format_from IS NULL OR format_from <> format_to),
    CHECK (kind NOT IN ('restore', 'relay_gap', 'consumer_redelivery') OR consumer IS NOT NULL),
    CHECK ((state = 'held') = (hold_reason IS NOT NULL)),
    CHECK ((state IN ('reconciled', 'failed')) = (completed_at IS NOT NULL)),
    CHECK (state <> 'reconciled' OR outcome_digest IS NOT NULL),
    -- A restore without a retained signed capture cannot reconcile; it stays held.
    CHECK (kind <> 'restore' OR state <> 'reconciled' OR coverage_generation IS NOT NULL)
);
CREATE UNIQUE INDEX owner_reconciliation_running ON relay.owner_reconciliation (kind, scope)
    WHERE state = 'running';
CREATE INDEX owner_reconciliation_relocation ON relay.owner_reconciliation (relocation_id)
    WHERE relocation_id IS NOT NULL;
CREATE INDEX owner_reconciliation_erasure ON relay.owner_reconciliation (erasure_id)
    WHERE erasure_id IS NOT NULL;

CREATE FUNCTION relay.owner_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner reconciliation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.operation_id, OLD.request_digest, OLD.kind, OLD.scope, OLD.consumer,
      OLD.relocation_id, OLD.erasure_id, OLD.format_from, OLD.format_to, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.operation_id, NEW.request_digest, NEW.kind, NEW.scope, NEW.consumer,
      NEW.relocation_id, NEW.erasure_id, NEW.format_from, NEW.format_to, NEW.created_at)
     OR OLD.state IN ('reconciled', 'failed') THEN
    RAISE EXCEPTION 'owner reconciliation identity or outcome is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_reconciliation_guard BEFORE UPDATE OR DELETE ON relay.owner_reconciliation
    FOR EACH ROW EXECUTE FUNCTION relay.owner_reconciliation_guard();

-- One row per participating owner makes matching and mixed cuts explicit.
CREATE TABLE relay.owner_reconciliation_cut (
    reconciliation_id uuid NOT NULL REFERENCES relay.owner_reconciliation(id),
    owner text NOT NULL CHECK (owner IN
        ('account', 'access', 'content', 'source', 'graph', 'object', 'relay')),
    data_epoch text CHECK (data_epoch <> ''),
    sequence numeric CHECK (sequence >= 0 AND sequence = trunc(sequence)),
    cluster_id text CHECK (cluster_id ~ '^[0-9]{1,20}$'),
    wal_lsn pg_lsn,
    format_version text CHECK (length(format_version) BETWEEN 1 AND 100),
    coverage_digest text CHECK (coverage_digest ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN
        ('matched', 'behind', 'ahead', 'mismatch', 'missing', 'format_mismatch')),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (reconciliation_id, owner),
    CHECK ((data_epoch IS NULL) = (sequence IS NULL)),
    CHECK ((cluster_id IS NULL) = (wal_lsn IS NULL)),
    CHECK (status = 'missing' OR coverage_digest IS NOT NULL),
    CHECK (status <> 'format_mismatch' OR format_version IS NOT NULL)
);
CREATE TRIGGER owner_reconciliation_cut_immutable BEFORE UPDATE OR DELETE
    ON relay.owner_reconciliation_cut FOR EACH ROW EXECUTE FUNCTION relay.no_mutation();

-- Append-only findings; a later pass records a new reconciliation, not an edit.
CREATE TABLE relay.owner_reconciliation_item (
    reconciliation_id uuid NOT NULL REFERENCES relay.owner_reconciliation(id),
    ordinal integer NOT NULL CHECK (ordinal >= 1),
    owner text NOT NULL CHECK (owner IN
        ('account', 'access', 'content', 'source', 'graph', 'object', 'relay')),
    item_kind text NOT NULL CHECK (item_kind IN ('revision', 'anchor', 'payload', 'receipt',
        'outbox_event', 'relay_batch', 'consumer_effect', 'preparation_pin', 'deletion_intent',
        'erasure', 'authority_fence', 'retention_pin')),
    item_ref text NOT NULL CHECK (length(item_ref) BETWEEN 1 AND 512),
    disposition text NOT NULL CHECK (disposition IN ('matched', 'replayed', 'rebuilt',
        'unavailable', 'corrupt', 'newer_unadopted', 'erased', 'gap', 'conflict',
        'preserved', 'retired')),
    evidence_digest text CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (reconciliation_id, ordinal),
    UNIQUE (reconciliation_id, owner, item_kind, item_ref),
    CHECK (disposition NOT IN ('matched', 'replayed', 'rebuilt', 'preserved', 'retired')
        OR evidence_digest IS NOT NULL)
);
CREATE INDEX owner_reconciliation_item_open ON relay.owner_reconciliation_item
    (reconciliation_id, ordinal) WHERE disposition IN ('unavailable', 'corrupt', 'gap', 'conflict');
CREATE TRIGGER owner_reconciliation_item_immutable BEFORE UPDATE OR DELETE
    ON relay.owner_reconciliation_item FOR EACH ROW EXECUTE FUNCTION relay.no_mutation();
