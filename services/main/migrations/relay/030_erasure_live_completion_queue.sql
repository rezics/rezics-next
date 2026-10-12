-- Live completion includes sealing and retention inventory, so target progress
-- alone cannot remove a crashed entry from the operator's bounded queue.
ALTER TABLE relay.erasure ADD COLUMN live_completion_pending boolean NOT NULL DEFAULT true;
ALTER TABLE relay.erasure ADD COLUMN last_completion_attempt timestamptz;
UPDATE relay.erasure e SET live_completion_pending=false
  WHERE stage IN ('blocked','verified') OR (stage='reconciling' AND NOT EXISTS (
    SELECT 1 FROM relay.erasure_target t WHERE t.erasure_id=e.id AND t.completion_state IS DISTINCT FROM 'completed'));
CREATE INDEX erasure_live_completion_pending ON relay.erasure
  (last_completion_attempt ASC NULLS FIRST, erasure_epoch)
  WHERE live_completion_pending AND kind='revision'
    AND stage IN ('requested','fenced','inventory_complete','deleting','reconciling');

CREATE FUNCTION relay.erasure_target_reopens_live_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE relay.erasure SET live_completion_pending=true
    WHERE id=NEW.erasure_id AND NOT live_completion_pending;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_target_reopens_live_completion
  AFTER INSERT OR UPDATE OF completion_state ON relay.erasure_target
  FOR EACH ROW WHEN (NEW.completion_state IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION relay.erasure_target_reopens_live_completion();
