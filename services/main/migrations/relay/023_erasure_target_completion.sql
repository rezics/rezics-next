-- Completion belongs to the retained target reference itself. The latest
-- kind-owner check remains in place while only progress fields can advance.
ALTER TABLE relay.erasure_target
  ADD COLUMN completion_state text DEFAULT 'pending',
  ADD COLUMN completion_reason_code text,
  ADD COLUMN completion_evidence_ref text,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT erasure_target_completion_state_check
    CHECK (completion_state IS NULL OR completion_state IN ('pending', 'failed', 'completed', 'legacy')),
  ADD CONSTRAINT erasure_target_completion_reason_code_check
    CHECK (completion_reason_code IS NULL OR completion_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT erasure_target_completion_evidence_ref_check
    CHECK (completion_evidence_ref IS NULL OR completion_evidence_ref ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT erasure_target_pending_completion_check
    CHECK (coalesce(completion_state, 'pending') <> 'pending' OR
      (completion_reason_code IS NULL AND completion_evidence_ref IS NULL AND completed_at IS NULL)),
  ADD CONSTRAINT erasure_target_failed_completion_check
    CHECK (completion_state <> 'failed' OR
      (completion_reason_code IS NOT NULL AND completion_evidence_ref IS NULL AND completed_at IS NULL)),
  ADD CONSTRAINT erasure_target_completed_completion_check
    CHECK (completion_state <> 'completed' OR
      (completion_reason_code IS NULL AND completion_evidence_ref IS NOT NULL AND completed_at IS NOT NULL)),
  ADD CONSTRAINT erasure_target_legacy_completion_check
    CHECK (completion_state <> 'legacy' OR
      (completion_reason_code IS NULL AND completion_evidence_ref IS NULL AND completed_at IS NULL));

-- Replace the blanket immutable-row trigger without changing the target's
-- identity, ordinal bound, or latest kind-owner CHECK.
DROP TRIGGER erasure_target_immutable ON relay.erasure_target;

-- A previous verified header predates target-level proof. Keep its targets
-- visibly unqualified until a bounded owner inventory completes each one.
UPDATE relay.erasure_target t SET completion_state = 'legacy'
FROM relay.erasure e
WHERE e.id = t.erasure_id AND e.stage = 'verified';

CREATE FUNCTION relay.erasure_target_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_state text;
  new_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retained erasure target cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF ROW(OLD.erasure_id, OLD.ordinal, OLD.owner, OLD.target_kind, OLD.target_ref)
      IS DISTINCT FROM ROW(NEW.erasure_id, NEW.ordinal, NEW.owner, NEW.target_kind, NEW.target_ref) THEN
    RAISE EXCEPTION 'erasure target identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF ROW(OLD.completion_state, OLD.completion_reason_code, OLD.completion_evidence_ref, OLD.completed_at)
      IS NOT DISTINCT FROM ROW(NEW.completion_state, NEW.completion_reason_code,
        NEW.completion_evidence_ref, NEW.completed_at) THEN
    RETURN NEW;
  END IF;

  old_state := coalesce(OLD.completion_state, 'pending');
  new_state := coalesce(NEW.completion_state, 'pending');
  IF old_state = 'completed' THEN
    RAISE EXCEPTION 'completed erasure target evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((old_state = 'pending' AND new_state IN ('failed', 'completed'))
      OR (old_state = 'failed' AND new_state = 'completed')
      OR (old_state = 'legacy' AND new_state IN ('failed', 'completed'))) THEN
    RAISE EXCEPTION 'erasure target completion transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER erasure_target_completion_guard BEFORE UPDATE OR DELETE ON relay.erasure_target
    FOR EACH ROW EXECUTE FUNCTION relay.erasure_target_completion_guard();

-- A journal summary cannot become verified until every retained target has
-- reached its successful terminal state.
CREATE FUNCTION relay.erasure_verified_targets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stage <> 'verified' AND NEW.stage = 'verified' AND EXISTS (
      SELECT 1 FROM relay.erasure_target t
      WHERE t.erasure_id = NEW.id AND t.completion_state IS DISTINCT FROM 'completed') THEN
    RAISE EXCEPTION 'erasure has incomplete target completion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_verified_targets_guard BEFORE UPDATE OF stage ON relay.erasure
    FOR EACH ROW EXECUTE FUNCTION relay.erasure_verified_targets_guard();
