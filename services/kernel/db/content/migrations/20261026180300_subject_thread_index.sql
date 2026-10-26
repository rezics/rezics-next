-- migrate:up
CREATE TABLE content.subject_thread (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  thread_route integer NOT NULL,
  thread_id uuid NOT NULL,
  place_id uuid NOT NULL,
  kind text NOT NULL,
  last_activity_at timestamptz NOT NULL,
  source_epoch integer NOT NULL,
  source_position bigint NOT NULL,
  PRIMARY KEY (route, subject_id, thread_id),
  CONSTRAINT subject_thread_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT subject_thread_thread_route_range_check CHECK (thread_route BETWEEN 0 AND 65535),
  CONSTRAINT subject_thread_kind_check CHECK (kind IN ('discussion', 'review')),
  CONSTRAINT subject_thread_last_activity_finite CHECK (isfinite(last_activity_at)),
  CONSTRAINT subject_thread_source_epoch_check CHECK (source_epoch > 0),
  CONSTRAINT subject_thread_source_position_check CHECK (source_position > 0),
  CONSTRAINT subject_thread_check CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CONSTRAINT subject_thread_thread_route_check CHECK (thread_route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11))
);

CREATE INDEX subject_thread_page_idx
  ON content.subject_thread (route, subject_id, place_id, kind, last_activity_at DESC, thread_id);

CREATE FUNCTION content.guard_subject_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.subject_id, NEW.thread_route, NEW.thread_id)
       IS DISTINCT FROM ROW(OLD.route, OLD.subject_id, OLD.thread_route, OLD.thread_id)
     OR ROW(NEW.source_epoch, NEW.source_position) <= ROW(OLD.source_epoch, OLD.source_position)
     OR NEW.last_activity_at < OLD.last_activity_at THEN
    RAISE EXCEPTION 'Subject thread identity, activity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subject_thread_identity BEFORE UPDATE ON content.subject_thread
FOR EACH ROW EXECUTE FUNCTION content.guard_subject_thread();

-- migrate:down
-- Forward only: subject thread projections are rebuilt from committed source events.
