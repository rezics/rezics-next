-- migrate:up
ALTER TABLE library.collection
  ADD COLUMN listing_ever_public boolean NOT NULL DEFAULT false;

CREATE TABLE library.collection_listing_history (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  collection_id uuid NOT NULL,
  ever_public boolean NOT NULL CHECK (ever_public),
  PRIMARY KEY (route, collection_id),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11))
);

CREATE FUNCTION library.collection_listing_public_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.collection_id::text, NEW.route::bigint));
    IF EXISTS (
      SELECT 1
      FROM library.collection_listing_history
      WHERE route = NEW.route AND collection_id = NEW.collection_id
    ) THEN
      RAISE EXCEPTION 'Collection identity has public history'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'collection_listing_history_pkey';
    END IF;
    NEW.listing_ever_public := NEW.state = 'active' AND NEW.visibility = 'public';
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.route, NEW.collection_id) IS DISTINCT FROM (OLD.route, OLD.collection_id) THEN
      RAISE EXCEPTION 'Collection source identity is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'collection_source_identity_immutable';
    END IF;
    NEW.listing_ever_public := OLD.listing_ever_public
      OR (OLD.state = 'active' AND OLD.visibility = 'public')
      OR (NEW.state = 'active' AND NEW.visibility = 'public');
    RETURN NEW;
  ELSE
    IF OLD.listing_ever_public OR (OLD.state = 'active' AND OLD.visibility = 'public') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(OLD.collection_id::text, OLD.route::bigint));
      INSERT INTO library.collection_listing_history (route, collection_id, ever_public)
      VALUES (OLD.route, OLD.collection_id, true)
      ON CONFLICT (route, collection_id) DO NOTHING;
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

CREATE TRIGGER collection_listing_public_history_guard
BEFORE INSERT OR UPDATE OR DELETE ON library.collection
FOR EACH ROW
EXECUTE FUNCTION library.collection_listing_public_history_guard();

-- migrate:down
-- Forward only: public identity history cannot be safely discarded.
