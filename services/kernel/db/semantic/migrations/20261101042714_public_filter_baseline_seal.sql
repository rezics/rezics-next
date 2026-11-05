-- migrate:up
CREATE FUNCTION semantic.retain_public_filter_baseline_seal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.coverage_generation IS NOT NULL AND
    NEW.coverage_generation IS DISTINCT FROM OLD.coverage_generation THEN
    RAISE EXCEPTION 'Original covered generation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.coverage_sealed AND
    (NEW.coverage_after,NEW.coverage_root,NEW.coverage_sealed,NEW.account_after)
    IS DISTINCT FROM
    (OLD.coverage_after,OLD.coverage_root,OLD.coverage_sealed,OLD.account_after)
  THEN
    RAISE EXCEPTION 'Original public-filter baseline seal is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.coverage_after,NEW.coverage_root,NEW.coverage_sealed)
    IS DISTINCT FROM (OLD.coverage_after,OLD.coverage_root,OLD.coverage_sealed)
    AND NOT (OLD.coverage_generation IS NULL AND NEW.coverage_after=0 AND NOT NEW.coverage_sealed)
    AND (NEW.coverage_after<>OLD.coverage_after+1 OR NEW.account_after<>NEW.coverage_after OR NOT EXISTS (
      SELECT 1 FROM search.public_filter_coverage_preparation c
      WHERE c.partition_no=NEW.partition_no AND c.bootstrap=NEW.bootstrap
        AND c.definition=NEW.read_definition AND c.generation=NEW.coverage_generation
        AND c.after_home=NEW.coverage_after AND c.root=NEW.coverage_root))
  THEN
    RAISE EXCEPTION 'Source seal requires its native contiguous coverage preparation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_bootstrap_baseline_seal
  BEFORE UPDATE ON semantic.public_filter_bootstrap
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_baseline_seal();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original Source baseline seals require retained retirement'; END $$;
