-- migrate:up
-- Presence stays NULL for retained rows from before the assessment receiver.
-- New native sessions start absent; explicit null and zero are recorded separately.
ALTER TABLE library.progress_session
  ADD COLUMN journal_assessment_presence text,
  ADD COLUMN reading_insights_assessment_initialized boolean NOT NULL DEFAULT false;
ALTER TABLE library.progress_session
  ALTER COLUMN journal_assessment_presence SET DEFAULT 'absent',
  ADD CONSTRAINT progress_session_journal_assessment_presence_check CHECK (
    journal_assessment_presence IS NULL OR journal_assessment_presence IN ('absent','explicit_null','value','unknown')
  ) NOT VALID,
  ADD CONSTRAINT progress_session_journal_assessment_presence_units_check CHECK (
    journal_assessment_presence IS NULL OR
    (journal_assessment_presence='value' AND journal_assessment_units IS NOT NULL) OR
    (journal_assessment_presence IN ('absent','explicit_null','unknown') AND journal_assessment_units IS NULL)
  ) NOT VALID;

CREATE TABLE library.reading_insights_assessment_installation (
  singleton boolean PRIMARY KEY CHECK (singleton),
  version integer NOT NULL CHECK (version=1)
);
CREATE TABLE library.reading_insights_assessment_owner (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  initialized_sessions bigint NOT NULL CHECK (initialized_sessions >= 0),
  revision uuid NOT NULL,
  PRIMARY KEY(route,account_id)
);
CREATE TABLE library.reading_insights_assessment_revision (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  meaning_revision smallint NOT NULL CHECK (meaning_revision BETWEEN 1 AND 16),
  absent bigint NOT NULL DEFAULT 0 CHECK (absent >= 0),
  explicit_null bigint NOT NULL DEFAULT 0 CHECK (explicit_null >= 0),
  valued bigint NOT NULL DEFAULT 0 CHECK (valued >= 0),
  historical_unknown bigint NOT NULL DEFAULT 0 CHECK (historical_unknown >= 0),
  PRIMARY KEY(route,account_id,meaning_revision)
);
CREATE TABLE library.reading_insights_assessment_value (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  meaning_revision smallint NOT NULL CHECK (meaning_revision BETWEEN 1 AND 16),
  units smallint NOT NULL CHECK (units BETWEEN 0 AND 20),
  occurrences bigint NOT NULL CHECK (occurrences > 0),
  PRIMARY KEY(route,account_id,meaning_revision,units)
);

CREATE FUNCTION library.reading_insights_assessment_apply(
  r integer,a uuid,m smallint,p text,u smallint,d integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous bigint; following bigint;
BEGIN
  INSERT INTO library.reading_insights_assessment_revision(route,account_id,meaning_revision)
    VALUES(r,a,m) ON CONFLICT(route,account_id,meaning_revision) DO NOTHING;
  UPDATE library.reading_insights_assessment_revision SET
    absent=absent+CASE WHEN p='absent' THEN d ELSE 0 END,
    explicit_null=explicit_null+CASE WHEN p='explicit_null' THEN d ELSE 0 END,
    valued=valued+CASE WHEN p='value' THEN d ELSE 0 END,
    historical_unknown=historical_unknown+CASE WHEN p='unknown' THEN d ELSE 0 END
    WHERE route=r AND account_id=a AND meaning_revision=m;
  IF p='value' THEN
    SELECT occurrences INTO previous FROM library.reading_insights_assessment_value
      WHERE route=r AND account_id=a AND meaning_revision=m AND units=u;
    following := COALESCE(previous,0)+d;
    IF following=0 THEN
      DELETE FROM library.reading_insights_assessment_value
        WHERE route=r AND account_id=a AND meaning_revision=m AND units=u;
    ELSE
      INSERT INTO library.reading_insights_assessment_value VALUES(r,a,m,u,following)
        ON CONFLICT(route,account_id,meaning_revision,units)
        DO UPDATE SET occurrences=EXCLUDED.occurrences;
    END IF;
  END IF;
  DELETE FROM library.reading_insights_assessment_revision
    WHERE route=r AND account_id=a AND meaning_revision=m
      AND absent=0 AND explicit_null=0 AND valued=0 AND historical_unknown=0;
END $$;

CREATE FUNCTION library.reading_insights_assessment_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  NEW.reading_insights_assessment_initialized := true;
  IF TG_OP='INSERT' AND NEW.journal_assessment_units IS NOT NULL
     AND NEW.journal_assessment_presence='absent' THEN
    NEW.journal_assessment_presence := 'value';
  ELSIF TG_OP='UPDATE' AND NEW.journal_assessment_units IS DISTINCT FROM OLD.journal_assessment_units
     AND NEW.journal_assessment_presence IS NOT DISTINCT FROM OLD.journal_assessment_presence THEN
    NEW.journal_assessment_presence := CASE
      WHEN NEW.journal_assessment_units IS NULL THEN 'explicit_null' ELSE 'value' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reading_insights_assessment_mark BEFORE INSERT OR UPDATE OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.reading_insights_assessment_mark();

CREATE FUNCTION library.reading_insights_assessment_receive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_presence text; new_presence text; old_eligible boolean; new_eligible boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO library.reading_insights_assessment_owner VALUES(NEW.route,NEW.account_id,0,gen_random_uuid())
      ON CONFLICT(route,account_id) DO NOTHING;
    PERFORM 1 FROM library.reading_insights_assessment_owner
      WHERE route=NEW.route AND account_id=NEW.account_id FOR UPDATE;
    new_presence := CASE
      WHEN NEW.journal_assessment_presence IS NULL AND NEW.journal_assessment_units IS NOT NULL THEN 'value'
      WHEN NEW.journal_assessment_presence IS NULL THEN 'unknown'
      ELSE NEW.journal_assessment_presence END;
    IF NEW.state<>'retired' THEN
      PERFORM library.reading_insights_assessment_apply(
        NEW.route,NEW.account_id,NEW.journal_assessment_meaning_revision,new_presence,
        NEW.journal_assessment_units,1);
    END IF;
    UPDATE library.reading_insights_assessment_owner SET
      initialized_sessions=initialized_sessions+1,revision=gen_random_uuid()
      WHERE route=NEW.route AND account_id=NEW.account_id;
    RETURN NEW;
  END IF;

  IF TG_OP='DELETE' THEN
    IF OLD.reading_insights_assessment_initialized THEN
      PERFORM 1 FROM library.reading_insights_assessment_owner
        WHERE route=OLD.route AND account_id=OLD.account_id FOR UPDATE;
      old_presence := CASE
        WHEN OLD.journal_assessment_presence IS NULL AND OLD.journal_assessment_units IS NOT NULL THEN 'value'
        WHEN OLD.journal_assessment_presence IS NULL THEN 'unknown'
        ELSE OLD.journal_assessment_presence END;
      IF OLD.state<>'retired' THEN
        PERFORM library.reading_insights_assessment_apply(
          OLD.route,OLD.account_id,OLD.journal_assessment_meaning_revision,old_presence,
          OLD.journal_assessment_units,-1);
      END IF;
      UPDATE library.reading_insights_assessment_owner SET
        initialized_sessions=initialized_sessions-1,revision=gen_random_uuid()
        WHERE route=OLD.route AND account_id=OLD.account_id;
      DELETE FROM library.reading_insights_assessment_owner
        WHERE route=OLD.route AND account_id=OLD.account_id AND initialized_sessions=0;
    END IF;
    RETURN OLD;
  END IF;

  old_eligible := OLD.state<>'retired';
  new_eligible := NEW.state<>'retired';
  old_presence := CASE
    WHEN OLD.journal_assessment_presence IS NULL AND OLD.journal_assessment_units IS NOT NULL THEN 'value'
    WHEN OLD.journal_assessment_presence IS NULL THEN 'unknown'
    ELSE OLD.journal_assessment_presence END;
  new_presence := CASE
    WHEN NEW.journal_assessment_presence IS NULL AND NEW.journal_assessment_units IS NOT NULL THEN 'value'
    WHEN NEW.journal_assessment_presence IS NULL THEN 'unknown'
    ELSE NEW.journal_assessment_presence END;

  IF OLD.reading_insights_assessment_initialized AND
     (OLD.route,OLD.account_id,OLD.journal_assessment_meaning_revision,old_presence,
       OLD.journal_assessment_units,old_eligible)
     IS NOT DISTINCT FROM
     (NEW.route,NEW.account_id,NEW.journal_assessment_meaning_revision,new_presence,
       NEW.journal_assessment_units,new_eligible) THEN
    RETURN NEW;
  END IF;

  INSERT INTO library.reading_insights_assessment_owner VALUES(NEW.route,NEW.account_id,0,gen_random_uuid())
    ON CONFLICT(route,account_id) DO NOTHING;
  PERFORM 1 FROM library.reading_insights_assessment_owner
    WHERE route=NEW.route AND account_id=NEW.account_id FOR UPDATE;
  IF OLD.reading_insights_assessment_initialized AND old_eligible THEN
    PERFORM library.reading_insights_assessment_apply(
      OLD.route,OLD.account_id,OLD.journal_assessment_meaning_revision,old_presence,
      OLD.journal_assessment_units,-1);
  END IF;
  IF new_eligible THEN
    PERFORM library.reading_insights_assessment_apply(
      NEW.route,NEW.account_id,NEW.journal_assessment_meaning_revision,new_presence,
      NEW.journal_assessment_units,1);
  END IF;
  UPDATE library.reading_insights_assessment_owner SET
    initialized_sessions=initialized_sessions+(NOT OLD.reading_insights_assessment_initialized)::integer,
    revision=gen_random_uuid()
    WHERE route=NEW.route AND account_id=NEW.account_id;
  RETURN NEW;
END $$;
CREATE TRIGGER reading_insights_assessment_receive AFTER INSERT OR UPDATE OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.reading_insights_assessment_receive();

CREATE FUNCTION library.reading_insights_assessment_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE library.reading_insights_assessment_owner,library.reading_insights_assessment_revision,
    library.reading_insights_assessment_value;
  RETURN NULL;
END $$;
CREATE TRIGGER reading_insights_assessment_truncate AFTER TRUNCATE ON library.progress_session
  FOR EACH STATEMENT EXECUTE FUNCTION library.reading_insights_assessment_truncate();
INSERT INTO library.reading_insights_assessment_installation VALUES(true,1);

-- migrate:down
-- Forward only: retained private assessment presence cannot be safely reconstructed.
