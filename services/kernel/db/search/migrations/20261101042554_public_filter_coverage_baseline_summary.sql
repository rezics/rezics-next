-- migrate:up
-- Generation zero describes an original enrollment, never an applied change.
ALTER TABLE search.public_filter_coverage_home
  DROP CONSTRAINT public_filter_coverage_home_last_change_generation_check,
  ADD CONSTRAINT public_filter_coverage_home_last_change_generation_check CHECK(last_change_generation >= 0),
  ADD COLUMN acknowledged_native_enqueue bigint NOT NULL DEFAULT 0 CHECK(acknowledged_native_enqueue >= 0);

CREATE FUNCTION search.retain_public_filter_coverage_baseline() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Original coverage baseline is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_coverage_baseline_immutable
  BEFORE UPDATE ON search.public_filter_coverage_baseline
  FOR EACH ROW EXECUTE FUNCTION search.retain_public_filter_coverage_baseline();

CREATE FUNCTION search.advance_public_filter_coverage_preparation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.partition_no,NEW.registration,NEW.bootstrap,NEW.definition,NEW.consumer,NEW.generation)
     IS DISTINCT FROM
     (OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.definition,OLD.consumer,OLD.generation)
  THEN
    RAISE EXCEPTION 'Original coverage preparation binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD AND
    (NEW.after_home <> OLD.after_home + 1 OR NOT EXISTS (
      SELECT 1 FROM search.public_filter_coverage_baseline b
      WHERE (b.partition_no,b.registration,b.bootstrap,b.source_home)=
        (OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.after_home)
        AND b.predecessor=OLD.root AND b.root=NEW.root))
  THEN
    RAISE EXCEPTION 'Coverage preparation requires its original contiguous receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_coverage_preparation_contiguous
  BEFORE UPDATE ON search.public_filter_coverage_preparation
  FOR EACH ROW EXECUTE FUNCTION search.advance_public_filter_coverage_preparation();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Coverage baseline summaries require original custody retirement'; END $$;
