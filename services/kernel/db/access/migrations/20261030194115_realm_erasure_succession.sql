-- migrate:up
-- Retain the exact Content-owned source episode with the native decision.
-- Null source fields identify older, unbound work; they never prove application.
ALTER TABLE access.realm_erasure_succession
  ADD COLUMN source_ownership_state text CHECK (source_ownership_state IN ('owned','orphaned')),
  ADD COLUMN source_orphaned_at timestamptz,
  ADD COLUMN source_claim_eligible_at timestamptz,
  ADD COLUMN result_orphaned_at timestamptz,
  ADD COLUMN result_claim_eligible_at timestamptz,
  ADD CONSTRAINT realm_erasure_succession_source_episode CHECK (
    source_ownership_state IS NULL OR
    (source_ownership_state='owned' AND source_orphaned_at IS NULL AND source_claim_eligible_at IS NULL) OR
    (source_ownership_state='orphaned' AND source_orphaned_at IS NOT NULL AND
      source_claim_eligible_at IS NOT NULL AND
      source_claim_eligible_at=source_orphaned_at+interval '720 hours')
  ),
  ADD CONSTRAINT realm_erasure_succession_result_episode CHECK (
    source_ownership_state IS NULL OR
    (decision_state IS DISTINCT FROM 'orphaned' AND
      result_orphaned_at IS NULL AND result_claim_eligible_at IS NULL) OR
    (decision_state='orphaned' AND result_orphaned_at IS NOT NULL AND
      result_claim_eligible_at IS NOT NULL AND
      result_orphaned_at=COALESCE(source_orphaned_at,source_at) AND
      result_claim_eligible_at=result_orphaned_at+interval '720 hours')
  );

CREATE OR REPLACE FUNCTION access.guard_realm_erasure_succession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Realm succession source custody has no consumer closure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route,NEW.resource_id,NEW.account_id,NEW.source_route,NEW.source_version,NEW.source_at,
         NEW.source_ownership_state,NEW.source_orphaned_at,NEW.source_claim_eligible_at)
       IS DISTINCT FROM ROW(OLD.route,OLD.resource_id,OLD.account_id,OLD.source_route,OLD.source_version,OLD.source_at,
         OLD.source_ownership_state,OLD.source_orphaned_at,OLD.source_claim_eligible_at)
     OR (OLD.decision_state IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Realm succession source and terminal decision are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Native Realm succession source custody cannot be rolled back';
END; $$;
