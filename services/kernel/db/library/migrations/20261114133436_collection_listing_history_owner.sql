-- migrate:up
ALTER TABLE library.collection_listing_history
  ADD COLUMN curator_account_id uuid;

ALTER TABLE library.collection_listing_history
  ADD CONSTRAINT collection_listing_history_curator_route_check
  CHECK (curator_account_id IS NULL OR route = get_byte(uuid_send(curator_account_id), 10) * 256
    + get_byte(uuid_send(curator_account_id), 11));

-- Only an exact surviving native header can supply historical ownership.
UPDATE library.collection_listing_history AS history
SET curator_account_id = collection.curator_account_id
FROM library.collection AS collection
WHERE collection.route = history.route
  AND collection.collection_id = history.collection_id
  AND collection.curator_account_id IS NOT NULL;

CREATE INDEX collection_listing_history_owner
  ON library.collection_listing_history (route, curator_account_id, collection_id)
  WHERE curator_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION library.collection_listing_public_history_guard()
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
    IF OLD.curator_account_id IS NOT NULL AND NEW.curator_account_id IS NULL THEN
      UPDATE library.collection_listing_history
      SET curator_account_id = NULL
      WHERE route = OLD.route AND collection_id = OLD.collection_id
        AND curator_account_id = OLD.curator_account_id;
    END IF;
    NEW.listing_ever_public := OLD.listing_ever_public
      OR (OLD.state = 'active' AND OLD.visibility = 'public')
      OR (NEW.state = 'active' AND NEW.visibility = 'public');
    RETURN NEW;
  ELSE
    IF OLD.listing_ever_public OR (OLD.state = 'active' AND OLD.visibility = 'public') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(OLD.collection_id::text, OLD.route::bigint));
      INSERT INTO library.collection_listing_history AS history
        (route, collection_id, ever_public, curator_account_id)
      VALUES (OLD.route, OLD.collection_id, true, OLD.curator_account_id)
      ON CONFLICT (route, collection_id) DO UPDATE
      SET curator_account_id = COALESCE(
        history.curator_account_id,
        EXCLUDED.curator_account_id
      );
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

-- migrate:down
-- Forward only: curator ownership is private provenance and public identity history is permanent.
