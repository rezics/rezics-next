-- migrate:up
-- Source receiving is installed atomically. Retained rows initialize only when an
-- addressed native mutation or an existing bounded shelf backfill page visits them.
ALTER TABLE library.progress_session ADD COLUMN reading_insights_initialized boolean NOT NULL DEFAULT false;
CREATE TABLE library.reading_insights_installation (
  singleton boolean PRIMARY KEY CHECK (singleton),
  version integer NOT NULL CHECK (version=1)
);
CREATE TABLE library.reading_insights_owner (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  initialized_sessions bigint NOT NULL CHECK (initialized_sessions >= 0),
  revision uuid NOT NULL,
  PRIMARY KEY(route,account_id)
);
CREATE TABLE library.reading_insights_year (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 1 AND 9999),
  completed bigint NOT NULL CHECK (completed > 0),
  repeats bigint NOT NULL CHECK (repeats BETWEEN 0 AND completed),
  known_profiles bigint NOT NULL CHECK (known_profiles >= 0),
  PRIMARY KEY(route,account_id,year)
);
-- The full canonical retained pin, never a hash or a current profile ID alone.
-- Pins beyond the admitted byte budget contribute to the explicit unknown group.
CREATE TABLE library.reading_insights_profile (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  year integer NOT NULL,
  profile_key text COLLATE "C" NOT NULL CHECK (octet_length(profile_key) <= 1024),
  completed bigint NOT NULL CHECK (completed > 0),
  subjects bigint NOT NULL CHECK (subjects BETWEEN 1 AND completed),
  PRIMARY KEY(route,account_id,year,profile_key)
);
CREATE INDEX reading_insights_profile_top ON library.reading_insights_profile
  (route,account_id,year,completed DESC,profile_key) INCLUDE(subjects) WHERE profile_key <> '';
CREATE TABLE library.reading_insights_subject (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  year integer NOT NULL,
  profile_key text COLLATE "C" NOT NULL CHECK (octet_length(profile_key) <= 1024),
  subject_id uuid NOT NULL,
  completed bigint NOT NULL CHECK (completed > 0),
  PRIMARY KEY(route,account_id,year,profile_key,subject_id)
);

-- Caller holds the owner counter lock. Every lookup is an exact indexed key.
CREATE FUNCTION library.reading_insights_apply(r integer,a uuid,y integer,k text,s uuid,d integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE previous bigint; following bigint; subject_delta integer; group_delta integer;
BEGIN
  SELECT completed INTO previous FROM library.reading_insights_subject
    WHERE route=r AND account_id=a AND year=y AND profile_key=k AND subject_id=s;
  previous := COALESCE(previous,0);
  following := previous+d;
  subject_delta := (following>0)::integer-(previous>0)::integer;
  IF following=0 THEN
    DELETE FROM library.reading_insights_subject
      WHERE route=r AND account_id=a AND year=y AND profile_key=k AND subject_id=s;
  ELSE
    INSERT INTO library.reading_insights_subject VALUES(r,a,y,k,s,following)
      ON CONFLICT(route,account_id,year,profile_key,subject_id) DO UPDATE SET completed=EXCLUDED.completed;
  END IF;
  SELECT completed INTO previous FROM library.reading_insights_profile
    WHERE route=r AND account_id=a AND year=y AND profile_key=k;
  previous := COALESCE(previous,0);
  following := previous+d;
  group_delta := (following>0)::integer-(previous>0)::integer;
  IF following=0 THEN
    DELETE FROM library.reading_insights_profile
      WHERE route=r AND account_id=a AND year=y AND profile_key=k;
  ELSE
    UPDATE library.reading_insights_profile SET completed=following, subjects=subjects+subject_delta
      WHERE route=r AND account_id=a AND year=y AND profile_key=k;
    IF NOT FOUND THEN
      INSERT INTO library.reading_insights_profile VALUES(r,a,y,k,following,subject_delta);
    END IF;
  END IF;
  SELECT completed INTO previous FROM library.reading_insights_year WHERE route=r AND account_id=a AND year=y;
  IF previous+d=0 THEN
    DELETE FROM library.reading_insights_year WHERE route=r AND account_id=a AND year=y;
  ELSE
    UPDATE library.reading_insights_year SET completed=completed+d,
      repeats=repeats+d-subject_delta, known_profiles=known_profiles+group_delta*(k<>'')::integer
      WHERE route=r AND account_id=a AND year=y;
    IF NOT FOUND THEN
      INSERT INTO library.reading_insights_year VALUES(r,a,y,d,d-subject_delta,group_delta*(k<>'')::integer);
    END IF;
  END IF;
END $$;

CREATE FUNCTION library.reading_insights_receive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item library.progress_session; d integer; k text;
BEGIN
  -- An unchanged membership still receives a fresh generation. Receipt replay
  -- does not write the source and therefore changes neither counters nor revision.
  IF TG_OP='UPDATE' AND OLD.reading_insights_initialized AND
    (OLD.route,OLD.account_id,OLD.subject_id,OLD.state,OLD.library_profile_pin,
      OLD.journal_finish_year,OLD.journal_finish_month,OLD.journal_finish_day)
    IS NOT DISTINCT FROM
    (NEW.route,NEW.account_id,NEW.subject_id,NEW.state,NEW.library_profile_pin,
      NEW.journal_finish_year,NEW.journal_finish_month,NEW.journal_finish_day) THEN
    UPDATE library.reading_insights_owner SET revision=gen_random_uuid()
      WHERE route=NEW.route AND account_id=NEW.account_id;
    NEW.reading_insights_initialized := true;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    PERFORM 1 FROM library.reading_insights_owner
      WHERE (route,account_id) IN ((OLD.route,OLD.account_id),(NEW.route,NEW.account_id))
      ORDER BY route,account_id FOR UPDATE;
  END IF;
  FOR d IN -1..1 BY 2 LOOP
    IF d=-1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
      IF NOT item.reading_insights_initialized THEN CONTINUE; END IF;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    INSERT INTO library.reading_insights_owner VALUES(item.route,item.account_id,0,gen_random_uuid())
      ON CONFLICT(route,account_id) DO UPDATE SET revision=EXCLUDED.revision;
    UPDATE library.reading_insights_owner SET initialized_sessions=initialized_sessions+d
      WHERE route=item.route AND account_id=item.account_id;
    IF item.state='completed' AND
      library.reported_finish_valid(item.journal_finish_year,item.journal_finish_month,item.journal_finish_day) THEN
      k := CASE WHEN item.library_profile_pin IS NOT NULL AND octet_length(item.library_profile_pin::text)<=1024
        THEN item.library_profile_pin::text ELSE '' END;
      PERFORM library.reading_insights_apply(item.route,item.account_id,item.journal_finish_year,k,item.subject_id,d);
    END IF;
  END LOOP;
  IF TG_OP<>'INSERT' THEN
    DELETE FROM library.reading_insights_owner
      WHERE route=OLD.route AND account_id=OLD.account_id AND initialized_sessions=0;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  NEW.reading_insights_initialized := true;
  RETURN NEW;
END $$;
CREATE TRIGGER reading_insights_receive BEFORE INSERT OR UPDATE OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.reading_insights_receive();
CREATE FUNCTION library.reading_insights_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE library.reading_insights_subject,library.reading_insights_profile,
    library.reading_insights_year,library.reading_insights_owner;
  RETURN NULL;
END $$;
CREATE TRIGGER reading_insights_truncate AFTER TRUNCATE ON library.progress_session
  FOR EACH STATEMENT EXECUTE FUNCTION library.reading_insights_truncate();
INSERT INTO library.reading_insights_installation VALUES(true,1);

-- migrate:down
-- Forward only: receiving and source ownership must move together.
