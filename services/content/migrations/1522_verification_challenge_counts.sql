-- Challenge summaries are one natural per-claim head read. Drain old trigger
-- invocations before preparing retained counts and installing the leaf lifecycle.
LOCK TABLE verification.challenge, verification.challenge_resolution,
  verification.challenge_pending IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE verification.challenge_head ADD COLUMN resolved_count bigint NOT NULL DEFAULT 0
  CHECK (resolved_count >= 0);

-- Inventory-sized preparation happens once. Repair a queue count left by an
-- old physical pending-row removal, advancing its exact freshness head only
-- when that previously observable open count changed.
WITH pending AS (
  SELECT claim, count(*)::int AS amount FROM verification.challenge_pending GROUP BY claim
), resolved AS (
  SELECT c.claim, count(*) AS amount FROM verification.challenge_resolution r
    JOIN verification.challenge c ON c.id = r.challenge_id GROUP BY c.claim
), prepared AS (
  SELECT h.claim, COALESCE(p.amount, 0) AS open_count, COALESCE(r.amount, 0) AS resolved_count
    FROM verification.challenge_head h LEFT JOIN pending p ON p.claim = h.claim
      LEFT JOIN resolved r ON r.claim = h.claim
)
UPDATE verification.challenge_head h SET open_count = p.open_count, resolved_count = p.resolved_count,
  revision = h.revision + CASE WHEN h.open_count <> p.open_count THEN 1 ELSE 0 END,
  updated_at = CASE WHEN h.open_count <> p.open_count THEN clock_timestamp() ELSE h.updated_at END
  FROM prepared p WHERE p.claim = h.claim;

-- Pending deletion is the open-count effect, whether it is part of resolution
-- or physical queue retirement. The same revision bump covers the subsequent
-- resolved-count update inside the resolution's transaction.
CREATE FUNCTION verification.retire_pending_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE verification.challenge_head SET open_count = open_count - 1, revision = revision + 1,
    updated_at = clock_timestamp() WHERE claim = OLD.claim;
  RETURN OLD;
END $$;
CREATE TRIGGER challenge_pending_count_retirement AFTER DELETE ON verification.challenge_pending
  FOR EACH ROW EXECUTE FUNCTION verification.retire_pending_challenge();

CREATE OR REPLACE FUNCTION verification.resolve_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submitter uuid; claim_id text;
BEGIN
  SELECT c.principal_id, c.claim INTO submitter, claim_id FROM verification.challenge c
    JOIN verification.challenge_pending p ON p.challenge_id = c.id
    WHERE c.id = NEW.challenge_id FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'challenge is not pending' USING ERRCODE = '23514', CONSTRAINT = 'challenge_pending_once';
  END IF;
  IF (NEW.outcome = 'withdrawn') <> (NEW.principal_id = submitter) THEN
    RAISE EXCEPTION 'a submitter may only withdraw; resolution needs an independent decider'
      USING ERRCODE = '23514', CONSTRAINT = 'challenge_independent_resolution';
  END IF;
  DELETE FROM verification.challenge_pending WHERE challenge_id = NEW.challenge_id;
  UPDATE verification.challenge_head SET resolved_count = resolved_count + 1,
    updated_at = clock_timestamp() WHERE claim = claim_id;
  RETURN NEW;
END $$;

-- Ordinary resolution/challenge deletion remains forbidden by the existing
-- immutable guards. If explicit physical maintenance removes a retained
-- decision, its leaf effect decrements the cache in that same transaction.
-- Parent deletion still requires its pending/decision leaves to be removed by
-- the existing FKs; no new erasure or reopening capability is introduced here.
CREATE FUNCTION verification.retire_resolved_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE verification.challenge_head SET resolved_count = resolved_count - 1, revision = revision + 1,
    updated_at = clock_timestamp()
    WHERE claim = (SELECT claim FROM verification.challenge WHERE id = OLD.challenge_id);
  RETURN OLD;
END $$;
CREATE TRIGGER challenge_resolution_count_retirement AFTER DELETE ON verification.challenge_resolution
  FOR EACH ROW EXECUTE FUNCTION verification.retire_resolved_challenge();
