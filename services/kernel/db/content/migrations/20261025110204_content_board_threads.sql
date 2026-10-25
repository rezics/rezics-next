-- migrate:up
-- Identifier-only candidates. Disclosure must resolve the current source state.
-- Board and thread references intentionally have no cross-partition foreign keys.
CREATE TABLE content.board_thread (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  board_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  source_revision_id uuid,
  PRIMARY KEY (route, board_id, thread_id),
  CHECK (route = get_byte(uuid_send(board_id), 10) * 256 + get_byte(uuid_send(board_id), 11))
);

CREATE INDEX board_thread_page_idx ON content.board_thread (route, board_id, created_at, thread_id);

CREATE FUNCTION content.guard_board_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.board_id, NEW.thread_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.route, OLD.board_id, OLD.thread_id, OLD.created_at)
     OR ROW(NEW.source_epoch, NEW.source_position) <= ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Board candidate identity, ordering and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER board_thread_identity BEFORE UPDATE ON content.board_thread
FOR EACH ROW EXECUTE FUNCTION content.guard_board_thread();

-- migrate:down
-- Forward only: retain candidate source watermarks across replay.
