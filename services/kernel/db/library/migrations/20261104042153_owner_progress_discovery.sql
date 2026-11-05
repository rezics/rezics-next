-- migrate:up
CREATE TABLE library.progress_discovery_generation (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  PRIMARY KEY (route, account_id),
  CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))
);

CREATE INDEX progress_session_discovery_owner_page
  ON library.progress_session (route, account_id, started_at DESC, session_id)
  WHERE state <> 'retired';

CREATE INDEX progress_session_discovery_state_page
  ON library.progress_session (route, account_id, state, started_at DESC, session_id)
  WHERE state <> 'retired';

CREATE INDEX progress_session_discovery_mode_page
  ON library.progress_session (route, account_id, mode, started_at DESC, session_id)
  WHERE state <> 'retired';

CREATE INDEX progress_session_discovery_profile_page
  ON library.progress_session (route, account_id, (library_profile_pin ->> 'profileId'), started_at DESC, session_id)
  WHERE state <> 'retired' AND library_profile_pin IS NOT NULL;

CREATE INDEX progress_session_discovery_subject_state_page
  ON library.progress_session (route, account_id, subject_id, state, started_at DESC, session_id)
  WHERE state <> 'retired';

CREATE INDEX progress_session_discovery_subject_mode_page
  ON library.progress_session (route, account_id, subject_id, mode, started_at DESC, session_id)
  WHERE state <> 'retired';

CREATE INDEX progress_session_discovery_subject_profile_page
  ON library.progress_session (route, account_id, subject_id, (library_profile_pin ->> 'profileId'), started_at DESC, session_id)
  WHERE state <> 'retired' AND library_profile_pin IS NOT NULL;

CREATE FUNCTION library.advance_progress_discovery_generation_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO library.progress_discovery_generation (route, account_id, generation)
  SELECT route, account_id, 1 FROM new_rows GROUP BY route, account_id ORDER BY route, account_id
  ON CONFLICT (route, account_id) DO UPDATE
    SET generation = library.progress_discovery_generation.generation + 1;
  RETURN NULL;
END;
$$;

CREATE FUNCTION library.advance_progress_discovery_generation_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO library.progress_discovery_generation (route, account_id, generation)
  SELECT route, account_id, 1 FROM old_rows GROUP BY route, account_id ORDER BY route, account_id
  ON CONFLICT (route, account_id) DO UPDATE
    SET generation = library.progress_discovery_generation.generation + 1;
  RETURN NULL;
END;
$$;

CREATE FUNCTION library.advance_progress_discovery_generation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO library.progress_discovery_generation (route, account_id, generation)
  SELECT owners.route, owners.account_id, 1
  FROM (
    SELECT old.route, old.account_id
    FROM old_rows AS old JOIN new_rows AS new USING (route, session_id)
    WHERE (old.account_id, old.subject_id, old.state, old.mode, old.started_at, old.library_profile_pin)
      IS DISTINCT FROM
      (new.account_id, new.subject_id, new.state, new.mode, new.started_at, new.library_profile_pin)
    UNION
    SELECT new.route, new.account_id
    FROM old_rows AS old JOIN new_rows AS new USING (route, session_id)
    WHERE (old.account_id, old.subject_id, old.state, old.mode, old.started_at, old.library_profile_pin)
      IS DISTINCT FROM
      (new.account_id, new.subject_id, new.state, new.mode, new.started_at, new.library_profile_pin)
  ) AS owners
  GROUP BY owners.route, owners.account_id ORDER BY owners.route, owners.account_id
  ON CONFLICT (route, account_id) DO UPDATE
    SET generation = library.progress_discovery_generation.generation + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER progress_discovery_generation_insert
AFTER INSERT ON library.progress_session
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION library.advance_progress_discovery_generation_insert();

CREATE TRIGGER progress_discovery_generation_delete
AFTER DELETE ON library.progress_session
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION library.advance_progress_discovery_generation_delete();

CREATE TRIGGER progress_discovery_generation_filter_update
AFTER UPDATE ON library.progress_session
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION library.advance_progress_discovery_generation_update();

-- migrate:down
-- Forward only: dropping this index would remove currentness for retained native progress sessions.
