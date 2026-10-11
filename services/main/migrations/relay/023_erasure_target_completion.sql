-- Target identity remains immutable. Keep progress and proof in a one-to-one
-- retained row so retries can advance without changing the erasure reference.
CREATE TABLE relay.erasure_target_completion (
    erasure_id uuid NOT NULL,
    ordinal smallint NOT NULL,
    completion_state text NOT NULL DEFAULT 'pending'
        CHECK (completion_state IN ('pending', 'failed', 'completed')),
    failure_reason text CHECK (failure_reason IS NULL OR
        (length(btrim(failure_reason)) BETWEEN 1 AND 500)),
    completion_evidence_digest text CHECK (completion_evidence_digest ~ '^[0-9a-f]{64}$'),
    completed_at timestamptz,
    PRIMARY KEY (erasure_id, ordinal),
    FOREIGN KEY (erasure_id, ordinal) REFERENCES relay.erasure_target (erasure_id, ordinal),
    CHECK (completion_state <> 'pending' OR
        (failure_reason IS NULL AND completion_evidence_digest IS NULL AND completed_at IS NULL)),
    CHECK (completion_state <> 'failed' OR
        (failure_reason IS NOT NULL AND completion_evidence_digest IS NULL AND completed_at IS NULL)),
    CHECK (completion_state <> 'completed' OR
        (completion_evidence_digest IS NOT NULL AND completed_at IS NOT NULL))
);

-- Historical target references begin pending: migration cannot invent proof.
INSERT INTO relay.erasure_target_completion (erasure_id, ordinal)
SELECT erasure_id, ordinal FROM relay.erasure_target;

CREATE FUNCTION relay.create_erasure_target_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO relay.erasure_target_completion (erasure_id, ordinal)
  VALUES (NEW.erasure_id, NEW.ordinal);
  RETURN NULL;
END $$;
CREATE TRIGGER erasure_target_completion_create AFTER INSERT ON relay.erasure_target
    FOR EACH ROW EXECUTE FUNCTION relay.create_erasure_target_completion();

CREATE FUNCTION relay.erasure_target_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retained erasure target completion cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (OLD.erasure_id, OLD.ordinal) IS DISTINCT FROM (NEW.erasure_id, NEW.ordinal) THEN
    RAISE EXCEPTION 'erasure target completion identity is immutable' USING ERRCODE = '23514';
  END IF;
  old_rank := CASE OLD.completion_state WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END;
  new_rank := CASE NEW.completion_state WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END;
  IF new_rank < old_rank THEN
    RAISE EXCEPTION 'erasure target completion cannot regress' USING ERRCODE = '23514';
  END IF;
  IF OLD.failure_reason IS NOT NULL AND NEW.failure_reason IS DISTINCT FROM OLD.failure_reason THEN
    RAISE EXCEPTION 'erasure target failure reason is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.failure_reason IS NULL AND NEW.failure_reason IS NOT NULL
      AND NEW.completion_state <> 'failed' THEN
    RAISE EXCEPTION 'erasure target failure reason requires a failed outcome' USING ERRCODE = '23514';
  END IF;
  IF OLD.completion_evidence_digest IS NOT NULL
      AND NEW.completion_evidence_digest IS DISTINCT FROM OLD.completion_evidence_digest THEN
    RAISE EXCEPTION 'erasure target completion evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'erasure target completion time is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_target_completion_guard BEFORE UPDATE OR DELETE
    ON relay.erasure_target_completion FOR EACH ROW
    EXECUTE FUNCTION relay.erasure_target_completion_guard();

CREATE FUNCTION relay.erasure_verified_targets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stage <> 'verified' AND NEW.stage = 'verified' AND EXISTS (
      SELECT 1 FROM relay.erasure_target t
      LEFT JOIN relay.erasure_target_completion c
        ON c.erasure_id = t.erasure_id AND c.ordinal = t.ordinal
      WHERE t.erasure_id = NEW.id AND c.completion_state IS DISTINCT FROM 'completed') THEN
    RAISE EXCEPTION 'erasure has incomplete target completion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_verified_targets_guard BEFORE UPDATE OF stage ON relay.erasure
    FOR EACH ROW EXECUTE FUNCTION relay.erasure_verified_targets_guard();
