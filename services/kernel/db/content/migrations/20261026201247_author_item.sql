-- migrate:up
CREATE TABLE content.author_item (
  route integer NOT NULL,
  author_account_id uuid NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN ('thread', 'post')),
  item_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  thread_kind text NOT NULL CHECK (thread_kind IN ('discussion', 'review')),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  PRIMARY KEY (route, author_account_id, item_kind, item_id),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route = get_byte(uuid_send(author_account_id), 10) * 256 + get_byte(uuid_send(author_account_id), 11)),
  CHECK ((item_kind = 'thread' AND item_id = thread_id) OR
    (item_kind = 'post' AND item_id <> thread_id)),
  CHECK (get_byte(uuid_send(item_id), 10) = get_byte(uuid_send(thread_id), 10) AND
    get_byte(uuid_send(item_id), 11) = get_byte(uuid_send(thread_id), 11))
);

CREATE INDEX author_item_page_idx
  ON content.author_item (route, author_account_id, item_kind, created_at DESC, item_id);

CREATE FUNCTION content.guard_author_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.author_account_id, NEW.item_kind, NEW.item_id, NEW.thread_id, NEW.thread_kind, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.route, OLD.author_account_id, OLD.item_kind, OLD.item_id, OLD.thread_id, OLD.thread_kind, OLD.created_at)
     OR ROW(NEW.source_epoch, NEW.source_position) <= ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Author item identity, creation time and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER author_item_identity BEFORE UPDATE ON content.author_item
FOR EACH ROW EXECUTE FUNCTION content.guard_author_item();

-- migrate:down
-- Forward only: author item projections are rebuilt from committed source events.
