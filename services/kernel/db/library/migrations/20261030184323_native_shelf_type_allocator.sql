-- migrate:up
CREATE TABLE library.shelf_writer_owner (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  fence_id uuid NOT NULL,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  state text NOT NULL CHECK (state IN ('initializing', 'open', 'rebuilding', 'purging', 'purged')),
  ready boolean NOT NULL DEFAULT false,
  active_generation uuid,
  build_generation uuid,
  requested_run uuid,
  enqueue_pending boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(fence_id), 10) * 256 + get_byte(uuid_send(fence_id), 11)),
  CHECK (fence_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CHECK (NOT ready OR active_generation IS NOT NULL)
);
CREATE INDEX shelf_writer_owner_pending ON library.shelf_writer_owner(route, account_id, requested_run)
  WHERE enqueue_pending;
COMMENT ON TABLE library.shelf_writer_owner IS 'Native counter serialization point and private reservation fence, subordinate to shelf_maintenance. The shared maintenance gate owns current epoch, readiness, durable backfill intent and active generation. Its lock precedes this row and all placement counters. Legacy intent columns confer no authority; terminal state is never inferred from a timer.';
ALTER TABLE library.shelf_count ADD CONSTRAINT shelf_count_safe_integer CHECK(n <= 9007199254740991);
ALTER TABLE library.shelf_type_reservation ADD COLUMN input_bytes bytea;
ALTER TABLE library.shelf_type_reservation ALTER COLUMN input_bytes SET STORAGE EXTERNAL;
COMMENT ON COLUMN library.shelf_type_reservation.input_bytes IS 'Immutable UTF8 bytes made from the same accepted ASCII input once. Historical NULL reservations cannot continue. Direct substring of this EXTERNAL datum bounds staging transfer without detoasting full text.';
CREATE FUNCTION library.guard_shelf_type_reservation_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.input_bytes IS NOT NULL AND NEW.input_bytes IS DISTINCT FROM convert_to(NEW.full_type, 'UTF8') THEN
      RAISE EXCEPTION 'Shelf reservation bytes must equal the accepted input';
    END IF;
  ELSIF (NEW.full_type, NEW.input_bytes, NEW.digest, NEW.fence_id, NEW.generation_id)
      IS DISTINCT FROM (OLD.full_type, OLD.input_bytes, OLD.digest, OLD.fence_id, OLD.generation_id) THEN
    RAISE EXCEPTION 'Shelf reservation input is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shelf_type_reservation_input_immutable BEFORE INSERT OR UPDATE ON library.shelf_type_reservation
  FOR EACH ROW EXECUTE FUNCTION library.guard_shelf_type_reservation_input();

CREATE INDEX type_preparation_request ON library.type_preparation_header
  (route, account_id, (binding ->> 'subjectId'), (binding ->> 'requestKey'), principal_namespace, created_at DESC, preparation_id DESC);

-- migrate:down
DROP INDEX library.type_preparation_request;
DROP TRIGGER shelf_type_reservation_input_immutable ON library.shelf_type_reservation;
DROP FUNCTION library.guard_shelf_type_reservation_input();
ALTER TABLE library.shelf_type_reservation DROP COLUMN input_bytes;
ALTER TABLE library.shelf_count DROP CONSTRAINT shelf_count_safe_integer;
DROP TABLE library.shelf_writer_owner;
