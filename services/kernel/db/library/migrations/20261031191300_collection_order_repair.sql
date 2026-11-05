-- migrate:up
ALTER TABLE library.collection DROP CONSTRAINT collection_member_count_check;
ALTER TABLE library.collection ADD CONSTRAINT collection_member_count_check CHECK (member_count >= 0);

-- One immutable capture per owner. Progress replaces only this fixed-width row;
-- completed/cancelled captures are removed by their locator-only continuation.
CREATE TABLE library.collection_order_repair (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  repair_id uuid NOT NULL,
  admitted_count integer NOT NULL CHECK (admitted_count > 0),
  original_minimum text COLLATE "C" NOT NULL CHECK (octet_length(original_minimum) BETWEEN 1 AND 48),
  lower_key text COLLATE "C" NOT NULL CHECK (octet_length(lower_key) BETWEEN 1 AND 48),
  upper_key text COLLATE "C" NOT NULL CHECK (octet_length(upper_key) BETWEEN 1 AND 48),
  admitted_revision integer NOT NULL,
  admitted_source_generation bigint NOT NULL,
  admitted_order_epoch integer NOT NULL,
  expected_revision integer NOT NULL,
  expected_source_generation bigint NOT NULL,
  expected_order_epoch integer NOT NULL,
  processed integer NOT NULL DEFAULT 0 CHECK (processed >= 0 AND processed <= admitted_count),
  step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
  after_key text COLLATE "C",
  after_member_id uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','complete','cancelled')),
  writer_xid xid8,
  PRIMARY KEY (route, collection_id),
  UNIQUE (route, repair_id),
  FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id) ON DELETE CASCADE,
  CHECK (lower_key < upper_key AND upper_key < original_minimum),
  CHECK ((after_key IS NULL) = (after_member_id IS NULL)),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route = get_byte(uuid_send(repair_id),10)*256+get_byte(uuid_send(repair_id),11))
);

CREATE FUNCTION library.guard_collection_order_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.route,NEW.collection_id,NEW.repair_id,NEW.admitted_count,NEW.original_minimum,NEW.lower_key,NEW.upper_key,
      NEW.admitted_revision,NEW.admitted_source_generation,NEW.admitted_order_epoch)
     IS DISTINCT FROM
     (OLD.route,OLD.collection_id,OLD.repair_id,OLD.admitted_count,OLD.original_minimum,OLD.lower_key,OLD.upper_key,
      OLD.admitted_revision,OLD.admitted_source_generation,OLD.admitted_order_epoch)
     OR NEW.processed < OLD.processed OR NEW.step < OLD.step
     OR (OLD.state <> 'active' AND NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'Collection order capture is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_order_capture BEFORE UPDATE ON library.collection_order_repair
FOR EACH ROW EXECUTE FUNCTION library.guard_collection_order_capture();

-- All writers, including erasure and retained-payload cleanup, share the native
-- barrier. Only the transaction advancing the captured CAS may rekey members.
CREATE FUNCTION library.guard_collection_order_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_route integer;
  owner_id uuid;
  curator uuid;
  parent_state text;
  repair library.collection_order_repair%ROWTYPE;
  terminal boolean;
BEGIN
  IF TG_OP='INSERT' THEN owner_route:=NEW.route; owner_id:=NEW.collection_id;
  ELSE owner_route:=OLD.route; owner_id:=OLD.collection_id; END IF;
  SELECT curator_account_id,state INTO curator,parent_state FROM library.collection
    WHERE route=owner_route AND collection_id=owner_id FOR UPDATE;
  SELECT * INTO repair FROM library.collection_order_repair
    WHERE route=owner_route AND collection_id=owner_id AND state='active';
  IF FOUND THEN
    SELECT state <> 'active' OR authn_fenced INTO terminal FROM access.account
      WHERE route=get_byte(uuid_send(curator),10)*256+get_byte(uuid_send(curator),11) AND account_id=curator;
    IF parent_state <> 'active' OR curator IS NULL OR COALESCE(terminal,true) THEN
      UPDATE library.collection_order_repair SET state='cancelled' WHERE route=owner_route AND collection_id=owner_id;
    ELSIF repair.writer_xid IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'Collection order repair in progress' USING ERRCODE='40001';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER collection_order_member BEFORE INSERT OR UPDATE OR DELETE ON library.collection_member
FOR EACH ROW EXECUTE FUNCTION library.guard_collection_order_member();

CREATE FUNCTION library.guard_collection_order_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  repair library.collection_order_repair%ROWTYPE;
  terminal boolean;
BEGIN
  SELECT * INTO repair FROM library.collection_order_repair
    WHERE route=OLD.route AND collection_id=OLD.collection_id AND state='active';
  IF FOUND THEN
    SELECT state <> 'active' OR authn_fenced INTO terminal FROM access.account
      WHERE route=get_byte(uuid_send(OLD.curator_account_id),10)*256+get_byte(uuid_send(OLD.curator_account_id),11)
        AND account_id=OLD.curator_account_id;
    IF TG_OP='DELETE' THEN
      UPDATE library.collection_order_repair SET state='cancelled' WHERE route=OLD.route AND collection_id=OLD.collection_id;
    ELSIF NEW.state <> 'active' OR NEW.curator_account_id IS DISTINCT FROM OLD.curator_account_id OR COALESCE(terminal,true) THEN
      UPDATE library.collection_order_repair SET state='cancelled' WHERE route=OLD.route AND collection_id=OLD.collection_id;
    ELSIF (NEW.member_count,NEW.revision,NEW.source_generation,NEW.order_epoch)
       IS DISTINCT FROM (OLD.member_count,OLD.revision,OLD.source_generation,OLD.order_epoch)
       AND (repair.writer_xid IS DISTINCT FROM pg_current_xact_id()
         OR NEW.member_count <> repair.admitted_count
         OR (NEW.revision,NEW.source_generation,NEW.order_epoch) IS DISTINCT FROM
            (repair.expected_revision,repair.expected_source_generation,repair.expected_order_epoch)) THEN
      RAISE EXCEPTION 'Collection order repair in progress' USING ERRCODE='40001';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER collection_order_parent BEFORE UPDATE OR DELETE ON library.collection
FOR EACH ROW EXECUTE FUNCTION library.guard_collection_order_parent();

-- migrate:down
-- Forward only: retained captures and expanded populations cannot be downgraded.
