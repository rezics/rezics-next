-- migrate:up
-- The ACK retirement pin has its own monotonic guard. Only cursor movement
-- needs an original contiguous coverage receipt.
CREATE OR REPLACE FUNCTION search.advance_public_filter_coverage_preparation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.partition_no,NEW.registration,NEW.bootstrap,NEW.definition,NEW.consumer,NEW.generation)
     IS DISTINCT FROM
     (OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.definition,OLD.consumer,OLD.generation)
  THEN
    RAISE EXCEPTION 'Original coverage preparation binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.after_home,NEW.root) IS DISTINCT FROM (OLD.after_home,OLD.root)
    AND NOT search.public_filter_baseline_interval(
      OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.after_home,NEW.after_home,OLD.root,NEW.root)
  THEN
    RAISE EXCEPTION 'Coverage preparation requires its original contiguous receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained ACK retirement requires forward migration'; END $$;
