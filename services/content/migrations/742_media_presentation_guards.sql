-- Applied 741 schemas may predate the final presentation guard and raw
-- clearance defaults. This forward migration upgrades them without changing
-- retained media, evidence, control heads or upload histories.
CREATE OR REPLACE FUNCTION media.field_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.slot,OLD.representation_id,OLD.use_id,OLD.field)
      IS DISTINCT FROM (NEW.slot,NEW.representation_id,NEW.use_id,NEW.field)
    OR NOT EXISTS (SELECT 1 FROM media.field_revision r WHERE r.id = NEW.head AND r.slot = OLD.slot
      AND r.predecessor IS NOT DISTINCT FROM OLD.head AND r.epoch = OLD.epoch + 1 AND NEW.epoch = r.epoch
      AND r.expected_protection IS NOT DISTINCT FROM OLD.protection_head
      AND r.expected_value IS NOT DISTINCT FROM OLD.value_head
      AND NEW.value_head IS NOT DISTINCT FROM CASE WHEN r.mode = 'unlock' THEN OLD.value_head ELSE r.id END
      AND NEW.protection_head IS NOT DISTINCT FROM CASE WHEN r.mode = 'lock' THEN r.id
        WHEN r.mode = 'unlock' THEN NULL ELSE OLD.protection_head END) THEN
    RAISE EXCEPTION 'media control advances only through its appended successor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.field_slot'::regclass
    AND tgname = 'field_slot_immutable_basis' AND NOT tgisinternal) THEN
    CREATE TRIGGER field_slot_immutable_basis BEFORE UPDATE OR DELETE ON media.field_slot
      FOR EACH ROW EXECUTE FUNCTION media.field_slot_guard();
  END IF;
END $$;

ALTER TABLE media.representation ALTER COLUMN clearance SET DEFAULT 'cleared';
CREATE OR REPLACE FUNCTION media.check_suppressed_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'original' THEN
    NEW.clearance = 'cleared'; NEW.clearance_reason = NULL;
    PERFORM pg_advisory_xact_lock(hashtextextended('media-copy:' || NEW.byte_digest, 0));
    IF media.digest_suppressed(NEW.byte_digest) THEN
      NEW.clearance = 'rejected'; NEW.clearance_reason = 'identical-copy-suppressed';
    END IF;
  ELSE
    SELECT clearance, clearance_reason INTO NEW.clearance, NEW.clearance_reason
      FROM media.representation WHERE id = NEW.source_id;
  END IF;
  RETURN NEW;
END $$;
