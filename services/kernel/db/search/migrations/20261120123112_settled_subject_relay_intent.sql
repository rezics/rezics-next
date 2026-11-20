-- migrate:up
CREATE FUNCTION search.clear_settled_relay_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Previous writers consume the retained bulk receipt without naming the intent column.
  NEW.relay_intent := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER identity_writer_clear_settled_relay_intent
BEFORE UPDATE OF writer_token ON search.identity_writer
FOR EACH ROW
WHEN (OLD.relay_intent IS NOT NULL AND NEW.relay_intent = OLD.relay_intent
  AND OLD.relay_receipt IS NOT NULL AND NEW.relay_receipt IS NULL
  AND NEW.dispatch_state = 'settled' AND NEW.writer_token IS NULL)
EXECUTE FUNCTION search.clear_settled_relay_intent();

-- migrate:down
DROP TRIGGER identity_writer_clear_settled_relay_intent ON search.identity_writer;
DROP FUNCTION search.clear_settled_relay_intent();
