-- migrate:up
-- Creation retention is installed before a home baseline is admitted. Legacy
-- receipts remain immutable and deliberately lack this additional authority.
ALTER TABLE semantic.public_filter_home_enrollment
  ADD COLUMN creation_consumer text CHECK (creation_consumer ~ '^public_filter_[0-9a-f]{32}$');

CREATE FUNCTION semantic.validate_public_filter_creation_pin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.complete AND (TG_OP='INSERT' OR OLD.receipt IS NULL) AND
    (NEW.creation_consumer IS DISTINCT FROM 'public_filter_' || replace(NEW.bootstrap::text,'-','')
      OR NOT EXISTS (
        SELECT 1 FROM core.consumer_checkpoint c
        WHERE c.partition_no=NEW.partition_no AND c.consumer=NEW.creation_consumer
          AND c.position<=NEW.creation_position
          AND (c.epoch IS NULL OR c.epoch=NEW.owner_epoch))) THEN
    RAISE EXCEPTION 'Original public-filter baseline requires its creation retention pin'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_home_creation_pin
  BEFORE INSERT OR UPDATE ON semantic.public_filter_home_enrollment
  FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_filter_creation_pin();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original public-filter creation pins require native retirement'; END $$;
