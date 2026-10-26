-- migrate:up
ALTER TABLE content.thread
  DROP CONSTRAINT thread_review_route_check,
  ADD CONSTRAINT thread_review_route_check CHECK (
    kind <> 'review' OR route = get_byte(uuid_send(author_account_id), 10) * 256 + get_byte(uuid_send(author_account_id), 11)
  );

DROP TRIGGER thread_review_board ON content.thread;
CREATE OR REPLACE FUNCTION content.guard_review_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.review_live IS FALSE AND NEW.review_live IS TRUE THEN
    RAISE EXCEPTION 'A removed review cannot become live again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_review_live BEFORE UPDATE ON content.thread
FOR EACH ROW EXECUTE FUNCTION content.guard_review_thread();

-- migrate:down
-- Forward only: author placement and irreversible review removal must survive rollback.
