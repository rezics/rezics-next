-- migrate:up
-- Fast constant-default column: no history aggregation or synthetic complete marker.
-- Existing shelf backfill's bounded sessions UPDATE initializes retained rows.
ALTER TABLE library.progress_session ADD COLUMN reported_year_initialized boolean NOT NULL DEFAULT false;

CREATE TABLE library.reported_year_owner (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  initialized_sessions bigint NOT NULL CHECK (initialized_sessions >= 0),
  missing_finish bigint NOT NULL CHECK (missing_finish >= 0),
  unsupported_finish bigint NOT NULL CHECK (unsupported_finish >= 0),
  revision uuid NOT NULL,
  PRIMARY KEY (route, account_id)
);

-- bucket=0 is the year head, 1..12 are calendar months, 13 is year-only.
CREATE TABLE library.reported_year_bucket (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 1 AND 9999),
  bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 13),
  completed bigint NOT NULL CHECK (completed > 0),
  subjects bigint NOT NULL CHECK (subjects BETWEEN 1 AND completed),
  unknown_profile bigint NOT NULL CHECK (unknown_profile BETWEEN 0 AND completed),
  month_precision bigint NOT NULL CHECK (month_precision BETWEEN 0 AND completed),
  day_precision bigint NOT NULL CHECK (day_precision BETWEEN 0 AND completed),
  PRIMARY KEY (route, account_id, year, bucket)
);
CREATE TABLE library.reported_year_subject (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 1 AND 9999),
  bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 13),
  subject_id uuid NOT NULL,
  completed bigint NOT NULL CHECK (completed > 0),
  PRIMARY KEY (route, account_id, year, bucket, subject_id)
);

-- Defensive admission mirrors the delivered journal Gregorian shape. No coercion,
-- audit-clock fallback, current-profile interpretation or private evidence copy.
CREATE FUNCTION library.reported_finish_valid(y integer, m integer, d integer) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(y BETWEEN 1 AND 9999
    AND (m IS NULL OR m BETWEEN 1 AND 12)
    AND (d IS NULL OR (m IS NOT NULL AND d BETWEEN 1 AND CASE
      WHEN m=2 THEN CASE WHEN y%400=0 OR (y%4=0 AND y%100<>0) THEN 29 ELSE 28 END
      WHEN m IN (4,6,9,11) THEN 30 ELSE 31 END)), false)
$$;

-- Caller holds the owner head. Exact membership transitions serialize concurrent
-- first/last subjects even when the changed source sessions differ.
CREATE FUNCTION library.reported_year_apply(r integer, a uuid, s uuid, y integer,
  b smallint, delta integer, unknown_delta integer, month_delta integer, day_delta integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE previous bigint; following bigint; subject_delta integer;
BEGIN
  SELECT completed INTO previous FROM library.reported_year_subject
    WHERE route=r AND account_id=a AND year=y AND bucket=b AND subject_id=s;
  previous := COALESCE(previous,0);
  following := previous+delta;
  subject_delta := (following>0)::integer-(previous>0)::integer;
  IF following=0 THEN
    DELETE FROM library.reported_year_subject
      WHERE route=r AND account_id=a AND year=y AND bucket=b AND subject_id=s;
  ELSE
    INSERT INTO library.reported_year_subject VALUES(r,a,y,b,s,following)
      ON CONFLICT(route,account_id,year,bucket,subject_id) DO UPDATE SET completed=EXCLUDED.completed;
  END IF;
  IF delta=-1 AND EXISTS(SELECT 1 FROM library.reported_year_bucket
      WHERE route=r AND account_id=a AND year=y AND bucket=b AND completed=1) THEN
    DELETE FROM library.reported_year_bucket WHERE route=r AND account_id=a AND year=y AND bucket=b;
  ELSE
    UPDATE library.reported_year_bucket SET
      completed=completed+delta, subjects=subjects+subject_delta,
      unknown_profile=unknown_profile+unknown_delta,
      month_precision=month_precision+month_delta, day_precision=day_precision+day_delta
      WHERE route=r AND account_id=a AND year=y AND bucket=b;
    IF NOT FOUND THEN
      INSERT INTO library.reported_year_bucket VALUES(r,a,y,b,delta,subject_delta,unknown_delta,month_delta,day_delta);
    END IF;
  END IF;
END $$;

CREATE FUNCTION library.reported_year_receive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item library.progress_session; delta integer; valid boolean; b smallint;
BEGIN
  IF TG_OP='UPDATE' AND OLD.reported_year_initialized AND
    (OLD.route,OLD.account_id,OLD.subject_id,OLD.state,OLD.library_profile_pin,
      OLD.journal_finish_year,OLD.journal_finish_month,OLD.journal_finish_day)
    IS NOT DISTINCT FROM
    (NEW.route,NEW.account_id,NEW.subject_id,NEW.state,NEW.library_profile_pin,
      NEW.journal_finish_year,NEW.journal_finish_month,NEW.journal_finish_day) THEN
    NEW.reported_year_initialized := true;
    RETURN NEW;
  END IF;
  -- Lock both potential owners in stable order (ordinary commands never move owners).
  IF TG_OP='UPDATE' THEN
    PERFORM 1 FROM library.reported_year_owner
      WHERE (route,account_id) IN ((OLD.route,OLD.account_id),(NEW.route,NEW.account_id))
      ORDER BY route,account_id FOR UPDATE;
  END IF;
  FOR delta IN -1..1 BY 2 LOOP
    IF delta=-1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
      IF NOT item.reported_year_initialized THEN CONTINUE; END IF;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    INSERT INTO library.reported_year_owner VALUES(item.route,item.account_id,0,0,0,gen_random_uuid())
      ON CONFLICT(route,account_id) DO UPDATE SET revision=EXCLUDED.revision;
    valid := library.reported_finish_valid(item.journal_finish_year,item.journal_finish_month,item.journal_finish_day);
    UPDATE library.reported_year_owner SET
      initialized_sessions=initialized_sessions+delta,
      missing_finish=missing_finish+delta*(item.state='completed' AND item.journal_finish_year IS NULL
        AND item.journal_finish_month IS NULL AND item.journal_finish_day IS NULL)::integer,
      unsupported_finish=unsupported_finish+delta*(item.state='completed' AND NOT valid AND NOT
        (item.journal_finish_year IS NULL AND item.journal_finish_month IS NULL AND item.journal_finish_day IS NULL))::integer
      WHERE route=item.route AND account_id=item.account_id;
    IF item.state='completed' AND valid THEN
      FOREACH b IN ARRAY ARRAY[0,COALESCE(item.journal_finish_month,13)]::smallint[] LOOP
        PERFORM library.reported_year_apply(item.route,item.account_id,item.subject_id,item.journal_finish_year,b,delta,
          delta*(item.library_profile_pin IS NULL)::integer,
          delta*(item.journal_finish_month IS NOT NULL AND item.journal_finish_day IS NULL)::integer,
          delta*(item.journal_finish_day IS NOT NULL)::integer);
      END LOOP;
    END IF;
  END LOOP;
  -- No owner tombstone or new deletion participant; native source deletion pays cleanup.
  IF TG_OP<>'INSERT' THEN
    DELETE FROM library.reported_year_owner WHERE route=OLD.route AND account_id=OLD.account_id AND initialized_sessions=0;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  NEW.reported_year_initialized := true;
  RETURN NEW;
END $$;
CREATE TRIGGER reported_year_receive BEFORE INSERT OR UPDATE OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.reported_year_receive();
CREATE FUNCTION library.reported_year_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE library.reported_year_subject,library.reported_year_bucket,library.reported_year_owner;
  RETURN NULL;
END $$;
CREATE TRIGGER reported_year_truncate AFTER TRUNCATE ON library.progress_session
  FOR EACH STATEMENT EXECUTE FUNCTION library.reported_year_truncate();

-- migrate:down
-- Forward only: source and synchronous derived ownership must move together.
