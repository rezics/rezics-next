-- Maintain seven rolling end-day ranks per Realm. Reads seek one rank index;
-- a source change updates only that Realm's retained end days. Preparing the
-- next UTC day belongs to the existing bounded directory worker.
ALTER TABLE access.realm_directory ADD COLUMN growth_epoch text NOT NULL DEFAULT '';
UPDATE access.realm_directory SET growth_epoch = COALESCE(
  (SELECT data_epoch FROM access.realm_directory_position WHERE singleton),'');
ALTER TABLE access.realm_directory_position
  ADD COLUMN growth_day date,
  ADD COLUMN growth_target_day date,
  ADD COLUMN growth_after_generation smallint NOT NULL DEFAULT 0,
  ADD COLUMN growth_after_realm text NOT NULL DEFAULT '';

CREATE TABLE access.realm_directory_growth (
  generation smallint NOT NULL,
  realm text NOT NULL,
  day date NOT NULL,
  data_epoch text NOT NULL,
  growth bigint NOT NULL,
  PRIMARY KEY (generation,realm,day),
  FOREIGN KEY (generation,realm) REFERENCES access.realm_directory(generation,realm) ON DELETE CASCADE
);
CREATE INDEX realm_directory_growth_realm ON access.realm_directory_growth(realm,day);
CREATE INDEX realm_directory_growth_rank ON access.realm_directory_growth(generation,day,(-growth),realm);

CREATE FUNCTION access.prepare_realm_directory_growth_row(slot smallint, resource text, epoch text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  DELETE FROM access.realm_directory_growth WHERE generation=slot AND realm=resource
    AND (day<today OR day>today+6);
  INSERT INTO access.realm_directory_growth(generation,realm,day,data_epoch,growth)
    SELECT slot,resource,today+n,epoch,COALESCE((SELECT sum(members+posts)
      FROM access.realm_growth_day WHERE realm=resource
        AND day BETWEEN today+n-6 AND today+n
        AND (data_epoch='' OR data_epoch=epoch)),0)::bigint
    FROM generate_series(0,6) AS days(n)
  ON CONFLICT(generation,realm,day) DO UPDATE SET data_epoch=EXCLUDED.data_epoch,growth=EXCLUDED.growth;
END $$;

CREATE FUNCTION access.initialize_realm_directory_growth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM access.prepare_realm_directory_growth_row(NEW.generation,NEW.realm,NEW.growth_epoch);
  RETURN NULL;
END $$;
CREATE TRIGGER realm_directory_growth_initialize AFTER INSERT OR UPDATE OF growth_epoch ON access.realm_directory
  FOR EACH ROW EXECUTE FUNCTION access.initialize_realm_directory_growth();

-- Share the per-Realm writer lock with directory publication and membership
-- counts, including when the source is a post rather than a membership.
CREATE FUNCTION access.lock_realm_directory_growth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('realm-count:' ||
    CASE WHEN TG_OP='DELETE' THEN OLD.realm ELSE NEW.realm END,0));
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER realm_directory_growth_lock BEFORE INSERT OR UPDATE OR DELETE ON access.realm_growth_day
  FOR EACH ROW EXECUTE FUNCTION access.lock_realm_directory_growth();

CREATE FUNCTION access.update_realm_directory_growth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    UPDATE access.realm_directory_growth SET growth=growth-(OLD.members+OLD.posts)
      WHERE realm=OLD.realm AND day BETWEEN OLD.day AND OLD.day+6
        AND (OLD.data_epoch='' OR data_epoch=OLD.data_epoch);
  END IF;
  IF TG_OP<>'DELETE' THEN
    UPDATE access.realm_directory_growth SET growth=growth+(NEW.members+NEW.posts)
      WHERE realm=NEW.realm AND day BETWEEN NEW.day AND NEW.day+6
        AND (NEW.data_epoch='' OR data_epoch=NEW.data_epoch);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER realm_directory_growth_update AFTER INSERT OR UPDATE OR DELETE ON access.realm_growth_day
  FOR EACH ROW EXECUTE FUNCTION access.update_realm_directory_growth();
