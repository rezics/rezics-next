-- migrate:up
-- Install and initialize under the same lock/transaction as the source trigger.
-- This deployment backfill is the only whole-history read; requests never replay it.
LOCK TABLE library.progress_session IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE library.consumption_statistics_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version = 1),
  complete boolean NOT NULL
);

CREATE TABLE library.consumption_statistics_owner (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  retained_sessions bigint NOT NULL CHECK (retained_sessions >= 0),
  completed_occurrences bigint NOT NULL CHECK (completed_occurrences >= 0),
  completed_subjects bigint NOT NULL CHECK (completed_subjects >= 0),
  unknown_profile_completed bigint NOT NULL CHECK (unknown_profile_completed >= 0),
  revision uuid NOT NULL,
  PRIMARY KEY (route, account_id),
  CHECK (completed_subjects <= completed_occurrences),
  CHECK (unknown_profile_completed <= completed_occurrences),
  CHECK (completed_occurrences <= retained_sessions)
);

CREATE TABLE library.consumption_statistics_subject (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  retained_sessions bigint NOT NULL CHECK (retained_sessions >= 0),
  completed_occurrences bigint NOT NULL CHECK (completed_occurrences >= 0),
  PRIMARY KEY (route, account_id, subject_id),
  CHECK (completed_occurrences <= retained_sessions)
);

INSERT INTO library.consumption_statistics_subject
SELECT route, account_id, subject_id, count(*), count(*) FILTER (WHERE state = 'completed')
FROM library.progress_session GROUP BY route, account_id, subject_id;

INSERT INTO library.consumption_statistics_owner
SELECT p.route, p.account_id, count(*), count(*) FILTER (WHERE p.state = 'completed'),
  count(DISTINCT p.subject_id) FILTER (WHERE p.state = 'completed'),
  count(*) FILTER (WHERE p.state = 'completed' AND p.library_profile_pin IS NULL), gen_random_uuid()
FROM library.progress_session p GROUP BY p.route, p.account_id;

-- Each invocation touches one owner header and one stored-subject counter. The owner
-- row serializes different sessions, including concurrent first completions of a subject.
CREATE FUNCTION library.consumption_statistics_apply(r integer, a uuid, s uuid,
  retained_delta integer, completed_delta integer, unknown_delta integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE before_completed bigint; after_completed bigint; remaining bigint;
BEGIN
  INSERT INTO library.consumption_statistics_owner
    VALUES (r, a, 0, 0, 0, 0, gen_random_uuid())
    ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;

  SELECT completed_occurrences INTO before_completed
    FROM library.consumption_statistics_subject
    WHERE route=r AND account_id=a AND subject_id=s FOR UPDATE;
  IF NOT FOUND THEN
    before_completed := 0;
    INSERT INTO library.consumption_statistics_subject
      VALUES (r, a, s, retained_delta, completed_delta)
      RETURNING completed_occurrences, retained_sessions INTO after_completed, remaining;
  ELSE
    UPDATE library.consumption_statistics_subject
      SET retained_sessions=retained_sessions+retained_delta,
          completed_occurrences=completed_occurrences+completed_delta
      WHERE route=r AND account_id=a AND subject_id=s
      RETURNING completed_occurrences, retained_sessions INTO after_completed, remaining;
  END IF;

  UPDATE library.consumption_statistics_owner
    SET retained_sessions=retained_sessions+retained_delta,
        completed_occurrences=completed_occurrences+completed_delta,
        completed_subjects=completed_subjects+(after_completed>0)::integer-(before_completed>0)::integer,
        unknown_profile_completed=unknown_profile_completed+unknown_delta
    WHERE route=r AND account_id=a;
  IF remaining=0 THEN
    DELETE FROM library.consumption_statistics_subject WHERE route=r AND account_id=a AND subject_id=s;
  END IF;
  -- The existing session erasure participant removes the last header too. No second
  -- account-deletion participant, job or retained owner tombstone is introduced.
  DELETE FROM library.consumption_statistics_owner
    WHERE route=r AND account_id=a AND retained_sessions=0;
END $$;

CREATE FUNCTION library.consumption_statistics_receive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- One source row remains one occurrence regardless of retries, scalar corrections,
  -- sparse units, clear, publication or a change in the accepted profile vocabulary.
  IF TG_OP <> 'INSERT' THEN
    PERFORM library.consumption_statistics_apply(OLD.route, OLD.account_id, OLD.subject_id,
      -1, -(OLD.state='completed')::integer,
      -((OLD.state='completed') AND OLD.library_profile_pin IS NULL)::integer);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM library.consumption_statistics_apply(NEW.route, NEW.account_id, NEW.subject_id,
      1, (NEW.state='completed')::integer,
      ((NEW.state='completed') AND NEW.library_profile_pin IS NULL)::integer);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER consumption_statistics_receive
  AFTER INSERT OR UPDATE OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.consumption_statistics_receive();

CREATE FUNCTION library.consumption_statistics_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE library.consumption_statistics_subject, library.consumption_statistics_owner;
  RETURN NULL;
END $$;
CREATE TRIGGER consumption_statistics_truncate AFTER TRUNCATE ON library.progress_session
  FOR EACH STATEMENT EXECUTE FUNCTION library.consumption_statistics_truncate();

INSERT INTO library.consumption_statistics_installation VALUES (true, 1, true);

-- migrate:down
-- Forward only: source and derived history must move together.
