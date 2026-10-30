-- migrate:up
-- Installation does not scan or rewrite the historical erasure domain. The partial
-- index is drained in batches of 48 under the same partition fence as live capture.
ALTER TABLE access.erasure ADD COLUMN auth_obligation_indexed boolean NOT NULL DEFAULT false;
CREATE INDEX auth_erasure_bootstrap ON access.erasure(route,account_id) WHERE NOT auth_obligation_indexed;
CREATE INDEX auth_erasure_original_floor ON access.lifecycle_fence_receipt(route,account_id,kind)
 INCLUDE(receipt_id,minimum_authn_epoch,transaction_id) WHERE kind='tombstone';

CREATE TABLE access.auth_erasure_source (
 partition_no integer PRIMARY KEY CHECK(partition_no BETWEEN 0 AND 4095),
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 source_epoch integer NOT NULL CHECK(source_epoch>0),
 source_owner text NOT NULL,
 head bigint NOT NULL DEFAULT 0 CHECK(head>=0),
 initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE access.auth_erasure_obligation (
 partition_no integer NOT NULL CHECK(partition_no=route/16),
 ordinal bigint NOT NULL CHECK(ordinal>0),
 route integer NOT NULL,
 account_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 at timestamptz NOT NULL,
 minimum_authn_epoch bigint CHECK(minimum_authn_epoch>0),
 receipt_id uuid,
 PRIMARY KEY(partition_no,ordinal),
 UNIQUE(route,account_id),
 FOREIGN KEY(route,account_id) REFERENCES access.erasure(route,account_id),
 CHECK((minimum_authn_epoch IS NULL)=(receipt_id IS NULL))
);
CREATE INDEX auth_erasure_pending ON access.auth_erasure_obligation(partition_no,ordinal)
 WHERE minimum_authn_epoch IS NULL;
CREATE TABLE access.auth_erasure_cut (
 cut_id uuid PRIMARY KEY,
 participant text NOT NULL DEFAULT 'auth' CHECK(participant='auth'),
 inventory_version integer NOT NULL DEFAULT 1 CHECK(inventory_version=1),
 producer_version integer NOT NULL DEFAULT 1 CHECK(producer_version=1),
 sealed_partitions integer NOT NULL DEFAULT 0 CHECK(sealed_partitions BETWEEN 0 AND 4096)
);
CREATE TABLE access.auth_erasure_cut_partition (
 cut_id uuid NOT NULL REFERENCES access.auth_erasure_cut,
 partition_no integer NOT NULL REFERENCES access.auth_erasure_source,
 generation uuid NOT NULL,
 source_epoch integer NOT NULL,
 source_owner text NOT NULL,
 source_position bigint NOT NULL CHECK(source_position>=0),
 high_water bigint NOT NULL CHECK(high_water>=0),
 PRIMARY KEY(cut_id,partition_no)
);
CREATE FUNCTION access.auth_erasure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Auth erasure source evidence is permanent and immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER auth_erasure_obligation_immutable BEFORE UPDATE OR DELETE ON access.auth_erasure_obligation
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();
CREATE TRIGGER auth_erasure_cut_partition_immutable BEFORE UPDATE OR DELETE ON access.auth_erasure_cut_partition
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();
CREATE FUNCTION access.auth_erasure_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth erasure source is permanent'; END IF;
 IF (NEW.partition_no,NEW.generation,NEW.source_epoch,NEW.source_owner)
    IS DISTINCT FROM (OLD.partition_no,OLD.generation,OLD.source_epoch,OLD.source_owner)
    OR NEW.head<OLD.head OR (OLD.initialized AND NOT NEW.initialized) THEN
  RAISE EXCEPTION 'Auth erasure source cannot change lineage or regress' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_source_guard BEFORE UPDATE OR DELETE ON access.auth_erasure_source
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_source_guard();
CREATE FUNCTION access.auth_erasure_cut_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth erasure cut is permanent'; END IF;
 IF (NEW.cut_id,NEW.participant,NEW.inventory_version,NEW.producer_version)
    IS DISTINCT FROM (OLD.cut_id,OLD.participant,OLD.inventory_version,OLD.producer_version)
    OR NEW.sealed_partitions<>OLD.sealed_partitions+1
    OR NOT EXISTS(SELECT 1 FROM access.auth_erasure_cut_partition
                  WHERE cut_id=OLD.cut_id AND partition_no=OLD.sealed_partitions) THEN
  RAISE EXCEPTION 'Auth erasure cut must advance by one retained native partition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_cut_guard BEFORE UPDATE OR DELETE ON access.auth_erasure_cut
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_cut_guard();

-- The existing native routing row serializes bootstrap, writers and cut capture.
-- There is no global erasure counter or new command/coordinator authority.
CREATE FUNCTION access.lock_auth_erasure_source(p integer,require_lineage boolean DEFAULT true) RETURNS access.auth_erasure_source
 LANGUAGE plpgsql AS $$
DECLARE home core.partition; source access.auth_erasure_source;
BEGIN
 SELECT * INTO home FROM core.partition WHERE partition_no=p AND p BETWEEN 0 AND 4095 FOR UPDATE;
 IF NOT FOUND OR home.write_state<>'active' THEN
  RAISE EXCEPTION 'Auth erasure source home unavailable' USING ERRCODE='40001';
 END IF;
 INSERT INTO access.auth_erasure_source(partition_no,source_epoch,source_owner)
 VALUES(p,home.epoch,home.node) ON CONFLICT DO NOTHING;
 SELECT * INTO source FROM access.auth_erasure_source WHERE partition_no=p FOR UPDATE;
 IF require_lineage AND (source.source_epoch<>home.epoch OR source.source_owner<>home.node) THEN
  RAISE EXCEPTION 'Auth erasure source lineage recovery required' USING ERRCODE='40001';
 END IF;
 RETURN source;
END; $$;

CREATE FUNCTION access.capture_auth_erasure_obligation(r integer,a uuid,native boolean) RETURNS void
 LANGUAGE plpgsql AS $$
DECLARE source access.auth_erasure_source; root access.erasure; terminal access.account;
 original access.lifecycle_fence_receipt; candidate access.lifecycle_fence_receipt; found_count integer:=0;
BEGIN
 -- Even while source lineage recovery is pending, current native deletion still
 -- commits and retains its exact obligation in the same ordinal feed. It cannot
 -- relabel the old source epoch or release a stale cut.
 source:=access.lock_auth_erasure_source(r/16,NOT native);
 SELECT * INTO root FROM access.erasure WHERE route=r AND account_id=a FOR UPDATE;
 IF NOT FOUND OR root.auth_obligation_indexed THEN RETURN; END IF;
 SELECT * INTO terminal FROM access.account WHERE route=r AND account_id=a;
 -- A receipt's original native tombstone kind is retained independently of the
 -- mutable current floor. Never infer the original floor from terminal or T.
 FOR candidate IN SELECT * FROM access.lifecycle_fence_receipt
  WHERE route=r AND account_id=a AND kind='tombstone' LIMIT 2
 LOOP
  found_count:=found_count+1; original:=candidate;
 END LOOP;
 IF found_count<>1 OR terminal.state<>'deleted' OR NOT terminal.authn_fenced
    OR terminal.minimum_authn_epoch<original.minimum_authn_epoch THEN
  original.minimum_authn_epoch:=NULL; original.receipt_id:=NULL;
 ELSIF native THEN
  -- New native capture must belong to the actual tombstone transaction, not a
  -- later read/relabel of the current floor or a fabricated old receipt.
  IF NOT EXISTS(SELECT 1 FROM access.lifecycle_fence_receipt f
     WHERE f.route=r AND f.account_id=a AND f.receipt_id=original.receipt_id
       AND f.transaction_id=terminal.transaction_id AND f.xmin::text=pg_current_xact_id()::text)
     OR terminal.fence_receipt_id<>original.receipt_id THEN
   original.minimum_authn_epoch:=NULL; original.receipt_id:=NULL;
  END IF;
 END IF;
 UPDATE access.auth_erasure_source SET head=head+1 WHERE partition_no=r/16 RETURNING * INTO source;
 INSERT INTO access.auth_erasure_obligation(partition_no,ordinal,route,account_id,version,at,minimum_authn_epoch,receipt_id)
 VALUES(r/16,source.head,r,a,root.version,root.at,original.minimum_authn_epoch,original.receipt_id);
 UPDATE access.erasure SET auth_obligation_indexed=true WHERE route=r AND account_id=a;
END; $$;
CREATE FUNCTION access.auth_erasure_producer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM access.capture_auth_erasure_obligation(NEW.route,NEW.account_id,true);
 RETURN NEW;
END; $$;
-- Deferred capture also sees the original fence receipt in the native lifecycle
-- transaction. It runs before COMMIT can expose the permanent erasure to Auth.
CREATE CONSTRAINT TRIGGER auth_erasure_producer AFTER INSERT ON access.erasure
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_producer();
CREATE FUNCTION access.auth_erasure_index_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP='UPDATE' AND OLD.auth_obligation_indexed AND NOT NEW.auth_obligation_indexed)
    OR (NEW.auth_obligation_indexed AND NOT EXISTS(
      SELECT 1 FROM access.auth_erasure_obligation WHERE route=NEW.route AND account_id=NEW.account_id)) THEN
  RAISE EXCEPTION 'Auth erasure index cannot discard source evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_index_guard BEFORE INSERT OR UPDATE ON access.erasure
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_index_guard();

CREATE FUNCTION access.initialize_auth_erasure_partition(p integer) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE source access.auth_erasure_source; item record;
BEGIN
 source:=access.lock_auth_erasure_source(p);
 IF source.initialized THEN RETURN true; END IF;
 FOR item IN SELECT route,account_id FROM access.erasure
   WHERE route BETWEEN p*16 AND p*16+15 AND NOT auth_obligation_indexed
   ORDER BY route,account_id LIMIT 48
 LOOP
  PERFORM access.capture_auth_erasure_obligation(item.route,item.account_id,false);
 END LOOP;
 IF EXISTS(SELECT 1 FROM access.erasure WHERE route BETWEEN p*16 AND p*16+15 AND NOT auth_obligation_indexed) THEN
  RETURN false;
 END IF;
 UPDATE access.auth_erasure_source SET initialized=true WHERE partition_no=p;
 RETURN true;
END; $$;

-- migrate:down
-- Forward only: an old binary must not discard independently surviving obligations.
DO $$ BEGIN RAISE EXCEPTION 'Auth erasure obligation feed requires forward recovery'; END $$;
