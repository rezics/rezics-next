-- Physical placement moves of one logical owner dataset. Stable identities never
-- embed a location. Activation requires the verified final source frontier, the
-- copied anchor registry and referenced object digests, a new routing epoch and a
-- new data epoch; the old copy is collected only after its recovery window.
-- Receipt positions keep their original epoch/sequence in the moved copy.
CREATE TABLE relay.owner_relocation (
    id uuid PRIMARY KEY,
    operation_id text NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 1 AND 200),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    owner text NOT NULL CHECK (owner IN ('graph', 'content', 'object')),
    dataset_id text NOT NULL CHECK (length(dataset_id) BETWEEN 1 AND 300),
    source_location text NOT NULL CHECK (length(source_location) BETWEEN 1 AND 500),
    target_location text NOT NULL CHECK (length(target_location) BETWEEN 1 AND 500),
    source_routing_epoch text NOT NULL CHECK (source_routing_epoch <> ''),
    target_routing_epoch text CHECK (target_routing_epoch <> ''),
    source_data_epoch text CHECK (source_data_epoch <> ''),
    source_sequence numeric CHECK (source_sequence >= 0 AND source_sequence = trunc(source_sequence)),
    target_data_epoch text CHECK (target_data_epoch <> ''),
    anchor_count bigint CHECK (anchor_count >= 0),
    anchor_digest text CHECK (anchor_digest ~ '^[0-9a-f]{64}$'),
    object_count bigint CHECK (object_count >= 0),
    object_digest text CHECK (object_digest ~ '^[0-9a-f]{64}$'),
    erasure_epoch bigint REFERENCES relay.erasure(erasure_epoch),
    state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'copying', 'draining',
        'verifying', 'activated', 'retaining', 'collected', 'aborted')),
    retain_until timestamptz,
    abort_reason text CHECK (length(abort_reason) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at timestamptz,
    collected_at timestamptz,
    CHECK (source_location <> target_location),
    CHECK ((source_data_epoch IS NULL) = (source_sequence IS NULL)),
    CHECK ((state IN ('activated', 'retaining', 'collected')) = (activated_at IS NOT NULL)),
    CHECK (activated_at IS NULL OR (target_routing_epoch IS NOT NULL
        AND target_routing_epoch <> source_routing_epoch AND source_data_epoch IS NOT NULL
        AND target_data_epoch IS NOT NULL AND target_data_epoch <> source_data_epoch
        AND anchor_count IS NOT NULL AND anchor_digest IS NOT NULL
        AND object_count IS NOT NULL AND object_digest IS NOT NULL)),
    CHECK (state NOT IN ('retaining', 'collected') OR retain_until IS NOT NULL),
    CHECK ((state = 'collected') = (collected_at IS NOT NULL)),
    CHECK (collected_at IS NULL OR collected_at >= retain_until),
    CHECK ((state = 'aborted') = (abort_reason IS NOT NULL))
);
-- At most one move per owner dataset is in flight or inside its recovery window,
-- so two copies are never both activation candidates.
CREATE UNIQUE INDEX owner_relocation_active ON relay.owner_relocation (owner, dataset_id)
    WHERE state NOT IN ('collected', 'aborted');

-- Verified evidence and activation are immutable once recorded; terminal moves stay closed.
CREATE FUNCTION relay.owner_relocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner relocation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.operation_id, OLD.request_digest, OLD.owner, OLD.dataset_id,
      OLD.source_location, OLD.target_location, OLD.source_routing_epoch, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.operation_id, NEW.request_digest, NEW.owner, NEW.dataset_id,
      NEW.source_location, NEW.target_location, NEW.source_routing_epoch, NEW.created_at)
     OR OLD.state IN ('collected', 'aborted')
     OR (OLD.activated_at IS NOT NULL AND (OLD.target_routing_epoch, OLD.source_data_epoch,
      OLD.source_sequence, OLD.target_data_epoch, OLD.anchor_count, OLD.anchor_digest,
      OLD.object_count, OLD.object_digest, OLD.erasure_epoch, OLD.activated_at)
      IS DISTINCT FROM (NEW.target_routing_epoch, NEW.source_data_epoch, NEW.source_sequence,
      NEW.target_data_epoch, NEW.anchor_count, NEW.anchor_digest, NEW.object_count,
      NEW.object_digest, NEW.erasure_epoch, NEW.activated_at)) THEN
    RAISE EXCEPTION 'owner relocation evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_relocation_guard BEFORE UPDATE OR DELETE ON relay.owner_relocation
    FOR EACH ROW EXECUTE FUNCTION relay.owner_relocation_guard();
