CREATE TABLE access.zone_browse_entry (
  realm text NOT NULL,
  work text NOT NULL,
  adopted_order numeric NOT NULL,
  updated_at timestamptz,
  word_count bigint CHECK (word_count >= 0),
  PRIMARY KEY (realm, work)
);
CREATE INDEX zone_browse_newest_idx ON access.zone_browse_entry
  (realm, adopted_order DESC, work DESC);
CREATE INDEX zone_browse_updated_idx ON access.zone_browse_entry
  (realm, updated_at DESC NULLS LAST, work DESC);
CREATE INDEX zone_browse_work_idx ON access.zone_browse_entry (work);

-- The statistics writer and its browse keys commit together. Old-generation
-- cleanup must not clear the current generation's values.
CREATE FUNCTION access.zone_browse_serial_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM access.serial_stats_checkpoint
    WHERE singleton AND generation = NEW.generation) THEN
    UPDATE access.zone_browse_entry SET updated_at = NEW.last_updated_at,
      word_count = NEW.word_count WHERE work = NEW.work;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zone_browse_serial_summary AFTER INSERT OR UPDATE ON access.serial_summary
  FOR EACH ROW EXECUTE FUNCTION access.zone_browse_serial_summary();

CREATE FUNCTION access.zone_browse_serial_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.generation IS DISTINCT FROM NEW.generation THEN
    UPDATE access.zone_browse_entry SET updated_at = NULL, word_count = NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zone_browse_serial_reset AFTER INSERT OR UPDATE ON access.serial_stats_checkpoint
  FOR EACH ROW EXECUTE FUNCTION access.zone_browse_serial_reset();
