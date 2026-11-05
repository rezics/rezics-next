-- migrate:up
-- Ordering tombstones retain only learned public identities; native apply establishes provenance later.
CREATE TABLE library.subject_collection_version (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  collection_route integer NOT NULL CHECK (collection_route BETWEEN 0 AND 65535),
  source_partition integer NOT NULL,
  source_epoch integer NOT NULL CHECK (source_epoch >= 1),
  source_position bigint NOT NULL CHECK (source_position >= 0),
  multiplicity integer NOT NULL CHECK (multiplicity >= 0),
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, collection_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (collection_route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (source_partition = collection_route >> 4)
);
CREATE INDEX subject_collection_version_reverse
  ON library.subject_collection_version (collection_route, collection_id, route, subject_id);

-- Legacy paired writers remain valid until separately locked cutover after bootstrap and drain.
ALTER TABLE library.subject_collection
  ADD COLUMN source_partition integer,
  ADD COLUMN source_epoch integer,
  ADD COLUMN source_position bigint,
  ADD CONSTRAINT subject_collection_source_check CHECK (
    (source_partition IS NULL AND source_epoch IS NULL AND source_position IS NULL)
    OR (source_partition IS NOT NULL AND source_epoch IS NOT NULL AND source_position IS NOT NULL
      AND source_partition = collection_route >> 4 AND source_epoch >= 1 AND source_position >= 0)
  );
CREATE INDEX subject_collection_reverse
  ON library.subject_collection (collection_route, collection_id, route, subject_id);

-- Whole-Collection zero at one target partition, never a private holder directory.
CREATE TABLE library.subject_collection_source_fence (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  collection_id uuid NOT NULL,
  collection_route integer NOT NULL CHECK (collection_route BETWEEN 0 AND 65535),
  source_partition integer NOT NULL,
  source_epoch integer NOT NULL CHECK (source_epoch >= 1),
  source_position bigint NOT NULL CHECK (source_position >= 0),
  terminal boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (partition_no, collection_id),
  CHECK (collection_route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (source_partition = collection_route >> 4)
);

CREATE FUNCTION library.guard_listing_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
    OR NEW.collection_route IS DISTINCT FROM OLD.collection_route
    OR NEW.source_partition IS DISTINCT FROM OLD.source_partition THEN
    RAISE EXCEPTION 'Listing source binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.source_epoch, NEW.source_position) < (OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Listing source stamp regressed' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'subject_collection_version' THEN
    IF NEW.route IS DISTINCT FROM OLD.route OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
      OR ((NEW.source_epoch, NEW.source_position) = (OLD.source_epoch, OLD.source_position)
        AND NEW.multiplicity IS DISTINCT FROM OLD.multiplicity) THEN
      RAISE EXCEPTION 'Listing identity or equal-stamp payload changed' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.partition_no IS DISTINCT FROM OLD.partition_no OR (OLD.terminal AND NOT NEW.terminal) THEN
      RAISE EXCEPTION 'Listing fence identity or terminal state changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER subject_collection_version_order BEFORE UPDATE ON library.subject_collection_version
  FOR EACH ROW EXECUTE FUNCTION library.guard_listing_order();
CREATE TRIGGER subject_collection_source_fence_order BEFORE UPDATE ON library.subject_collection_source_fence
  FOR EACH ROW EXECUTE FUNCTION library.guard_listing_order();

-- Pair/version matching and deletion guards activate under DDL locks only after native cutover preparation.
-- migrate:down
-- Forward only: retained ordering and terminal fences must not be discarded by rollback.
