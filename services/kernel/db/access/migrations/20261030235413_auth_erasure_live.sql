-- migrate:up
-- Receiver identity is supplied by trusted composition. It binds a restored Auth
-- generation to its original cut; it certifies no physical restore or consumption.
CREATE TABLE access.auth_erasure_live_receiver (
 cut_id uuid PRIMARY KEY REFERENCES access.auth_erasure_cut,
 auth_generation text NOT NULL CHECK(octet_length(auth_generation) BETWEEN 1 AND 1024),
 database_identity text NOT NULL CHECK(octet_length(database_identity) BETWEEN 1 AND 1024),
 inventory_entry text NOT NULL CHECK(octet_length(inventory_entry) BETWEEN 1 AND 1024),
 inventory_version text NOT NULL CHECK(octet_length(inventory_version) BETWEEN 1 AND 1024)
);
-- One shared enrollment frontier per native partition, independent of receiver
-- count. The original immutable ordinal feed IS the tail, not another engine.
CREATE TABLE access.auth_erasure_live_partition (
 partition_no integer PRIMARY KEY REFERENCES access.auth_erasure_source,
 generation uuid NOT NULL,
 source_epoch integer NOT NULL,
 source_owner text NOT NULL,
 enrollment_floor bigint NOT NULL CHECK(enrollment_floor>=0),
 enrolled_through bigint NOT NULL CHECK(enrolled_through>=enrollment_floor),
 lineage_valid boolean NOT NULL DEFAULT true
);
CREATE TABLE access.auth_erasure_live_subscription (
 cut_id uuid NOT NULL REFERENCES access.auth_erasure_live_receiver,
 partition_no integer NOT NULL REFERENCES access.auth_erasure_live_partition,
 generation uuid NOT NULL,
 source_epoch integer NOT NULL,
 source_owner text NOT NULL,
 high_water bigint NOT NULL CHECK(high_water>=0),
 arm_high_water bigint NOT NULL CHECK(arm_high_water>=high_water),
 PRIMARY KEY(cut_id,partition_no),
 FOREIGN KEY(cut_id,partition_no) REFERENCES access.auth_erasure_cut_partition
);
CREATE TRIGGER auth_erasure_live_receiver_immutable BEFORE UPDATE OR DELETE ON access.auth_erasure_live_receiver
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();
CREATE TRIGGER auth_erasure_live_subscription_immutable BEFORE UPDATE OR DELETE ON access.auth_erasure_live_subscription
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();

CREATE FUNCTION access.auth_erasure_live_partition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Auth live enrollment is permanent' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NOT NEW.lineage_valid OR NEW.enrollment_floor<>NEW.enrolled_through OR NOT EXISTS(
   SELECT 1 FROM access.auth_erasure_source s JOIN core.partition p USING(partition_no)
    WHERE s.partition_no=NEW.partition_no AND s.initialized AND s.head=NEW.enrolled_through
     AND (s.generation,s.source_epoch,s.source_owner)=(NEW.generation,NEW.source_epoch,NEW.source_owner)
     AND p.write_state='active' AND p.epoch=s.source_epoch AND p.node=s.source_owner) THEN
   RAISE EXCEPTION 'Auth live enrollment requires current native source' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (NEW.partition_no,NEW.generation,NEW.source_epoch,NEW.source_owner,NEW.enrollment_floor)
    IS DISTINCT FROM (OLD.partition_no,OLD.generation,OLD.source_epoch,OLD.source_owner,OLD.enrollment_floor)
    OR NEW.enrolled_through<>OLD.enrolled_through+1 OR (NOT OLD.lineage_valid AND NEW.lineage_valid)
    OR NOT EXISTS(SELECT 1 FROM access.auth_erasure_obligation
                  WHERE partition_no=NEW.partition_no AND ordinal=NEW.enrolled_through) THEN
   RAISE EXCEPTION 'Auth live enrollment cannot repin, skip or regress' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_live_partition_guard BEFORE INSERT OR UPDATE OR DELETE ON access.auth_erasure_live_partition
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_live_partition_guard();

CREATE FUNCTION access.auth_erasure_live_subscription_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM access.auth_erasure_cut_partition c
   JOIN access.auth_erasure_source s USING(partition_no)
   JOIN core.partition p USING(partition_no)
   JOIN access.auth_erasure_live_partition l USING(partition_no)
  WHERE c.cut_id=NEW.cut_id AND c.partition_no=NEW.partition_no
   AND (c.generation,c.source_epoch,c.source_owner,c.high_water)=
       (NEW.generation,NEW.source_epoch,NEW.source_owner,NEW.high_water)
   AND (s.generation,s.source_epoch,s.source_owner)=(c.generation,c.source_epoch,c.source_owner)
   AND (l.generation,l.source_epoch,l.source_owner)=(c.generation,c.source_epoch,c.source_owner)
   AND s.initialized AND s.head=NEW.arm_high_water AND l.enrolled_through=s.head AND l.lineage_valid
   AND p.write_state='active' AND p.epoch=c.source_epoch AND p.node=c.source_owner AND p.position>=c.source_position
   AND NOT EXISTS(SELECT 1 FROM access.auth_erasure_obligation o
                  WHERE o.partition_no=c.partition_no AND o.minimum_authn_epoch IS NULL)) THEN
  RAISE EXCEPTION 'Auth live subscription requires retained native cut and enrollment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_live_subscription_guard BEFORE INSERT ON access.auth_erasure_live_subscription
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_live_subscription_guard();

CREATE FUNCTION access.enroll_auth_erasure_live() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- capture_auth_erasure_obligation already holds the native home/source locks.
 -- A changed home keeps ordinary deletion working, but poisons this old lineage
 -- permanently until an actual native lineage handoff is implemented by its owner.
 UPDATE access.auth_erasure_live_partition l SET enrolled_through=NEW.ordinal,
  lineage_valid=l.lineage_valid AND EXISTS(
   SELECT 1 FROM access.auth_erasure_source s JOIN core.partition p USING(partition_no)
    WHERE s.partition_no=NEW.partition_no AND s.head=NEW.ordinal
     AND (s.generation,s.source_epoch,s.source_owner)=(l.generation,l.source_epoch,l.source_owner)
     AND p.write_state='active' AND p.epoch=l.source_epoch AND p.node=l.source_owner)
 WHERE l.partition_no=NEW.partition_no;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_live_enrollment AFTER INSERT ON access.auth_erasure_obligation
 FOR EACH ROW EXECUTE FUNCTION access.enroll_auth_erasure_live();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Auth live enrollment requires forward recovery'; END $$;
