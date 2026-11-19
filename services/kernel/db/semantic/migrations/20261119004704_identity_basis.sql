-- migrate:up
-- dbmate holds these writer exclusions through backfill and trigger installation.
LOCK TABLE core.partition, semantic.identity_epoch_control, semantic.identity_epoch_group,
  semantic.redirect IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE semantic.identity_home (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  epoch integer, node text, write_state text, moved_to text,
  generation numeric NOT NULL,
  group_pending bigint NOT NULL CHECK (group_pending >= 0),
  control_epoch bigint,
  control_pending boolean NOT NULL,
  pending bigint GENERATED ALWAYS AS (group_pending + control_pending::integer) STORED
);

INSERT INTO semantic.identity_home(partition_no,epoch,node,write_state,moved_to,generation,group_pending,control_epoch,control_pending)
SELECT h,p.epoch,p.node,p.write_state,p.moved_to,coalesce(g.generation,0)+coalesce(r.generation,0),
       coalesce(g.pending,0),c.published_epoch,c.pending_job IS NOT NULL
FROM generate_series(0,4095) h
LEFT JOIN core.partition p ON p.partition_no=h
LEFT JOIN semantic.identity_epoch_control c ON c.partition_no=h
LEFT JOIN (SELECT partition_no,sum(version) generation,count(pending_job) pending
           FROM semantic.identity_epoch_group GROUP BY partition_no) g ON g.partition_no=h
LEFT JOIN (SELECT route/16 home,sum(sequence::bigint) generation FROM semantic.redirect GROUP BY route/16) r ON r.home=h;

CREATE TABLE semantic.identity_basis_shard (
  shard integer PRIMARY KEY CHECK (shard BETWEEN 0 AND 63),
  active_homes integer NOT NULL CHECK (active_homes BETWEEN 0 AND 64),
  pending bigint NOT NULL CHECK (pending >= 0),
  basis bytea NOT NULL CHECK (octet_length(basis)=32)
);

-- The seed binds existing native topology and structural generations. A missing
-- partition retains its empty slot and cannot contribute to the ready count.
INSERT INTO semantic.identity_basis_shard
SELECT partition_no % 64,count(*) FILTER (WHERE write_state='active' AND control_epoch IS NOT NULL),sum(pending),
       sha256(convert_to(jsonb_agg(jsonb_build_array(partition_no,epoch,node,write_state,moved_to,control_epoch,generation)
                        ORDER BY partition_no)::text,'UTF8'))
FROM semantic.identity_home GROUP BY partition_no % 64;

CREATE FUNCTION semantic.update_identity_basis_shard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movement boolean := (OLD.epoch,OLD.node,OLD.write_state,OLD.moved_to,OLD.control_epoch,OLD.generation)
    IS DISTINCT FROM (NEW.epoch,NEW.node,NEW.write_state,NEW.moved_to,NEW.control_epoch,NEW.generation);
BEGIN
  IF movement OR OLD.pending<>NEW.pending THEN
    UPDATE semantic.identity_basis_shard
    SET active_homes=active_homes + coalesce((NEW.write_state='active' AND NEW.control_epoch IS NOT NULL)::int,0)
                                  - coalesce((OLD.write_state='active' AND OLD.control_epoch IS NOT NULL)::int,0),
        pending=pending + (NEW.pending-OLD.pending),
        basis=CASE WHEN movement THEN sha256(basis || convert_to(jsonb_build_array(
          NEW.partition_no,NEW.epoch,NEW.node,NEW.write_state,NEW.moved_to,NEW.control_epoch,NEW.generation)::text,'UTF8'))
          ELSE basis END
    WHERE shard=NEW.partition_no % 64;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing identity basis shard'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER identity_home_basis AFTER UPDATE ON semantic.identity_home
  FOR EACH ROW EXECUTE FUNCTION semantic.update_identity_basis_shard();

CREATE FUNCTION semantic.capture_identity_basis_topology() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' AND (TG_OP='DELETE' OR OLD.partition_no<>NEW.partition_no) THEN
    UPDATE semantic.identity_home SET epoch=NULL,node=NULL,write_state=NULL,moved_to=NULL WHERE partition_no=OLD.partition_no;
  END IF;
  IF TG_OP<>'DELETE' THEN
    UPDATE semantic.identity_home SET epoch=NEW.epoch,node=NEW.node,write_state=NEW.write_state,moved_to=NEW.moved_to
      WHERE partition_no=NEW.partition_no;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER identity_basis_topology AFTER INSERT OR DELETE OR UPDATE OF partition_no,epoch,node,write_state,moved_to
  ON core.partition FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_basis_topology();

-- Only structural changes advance the home generation. A claim and cancellation
-- with no published effect restore the same clean basis. Removing a redirect or
-- replacing a group generation still advances it, including a return to self.
CREATE FUNCTION semantic.capture_identity_basis_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_home integer;
  new_home integer;
  old_pending integer := 0;
  new_pending integer := 0;
  changed boolean := true;
BEGIN
  IF TG_TABLE_NAME='redirect' THEN
    old_home := OLD.route/16;
    new_home := NEW.route/16;
  ELSIF TG_TABLE_NAME='identity_epoch_group' THEN
    old_home := OLD.partition_no;
    new_home := NEW.partition_no;
    old_pending := (OLD.pending_job IS NOT NULL)::integer;
    new_pending := (NEW.pending_job IS NOT NULL)::integer;
    changed := (OLD.partition_no,OLD.terminal,OLD.generation,OLD.version,OLD.published_epoch,OLD.owner_epoch,OLD.ready,OLD.observed_count)
      IS DISTINCT FROM (NEW.partition_no,NEW.terminal,NEW.generation,NEW.version,NEW.published_epoch,NEW.owner_epoch,NEW.ready,NEW.observed_count);
  ELSE
    old_home := OLD.partition_no;
    new_home := NEW.partition_no;
    IF old_home IS NOT NULL AND old_home IS DISTINCT FROM new_home THEN
      UPDATE semantic.identity_home SET control_epoch=NULL,control_pending=false WHERE partition_no=old_home;
    END IF;
    IF new_home IS NOT NULL THEN
      UPDATE semantic.identity_home SET control_epoch=NEW.published_epoch,control_pending=NEW.pending_job IS NOT NULL
      WHERE partition_no=new_home;
    END IF;
    RETURN NULL;
  END IF;

  IF changed OR old_pending<>new_pending OR old_home IS DISTINCT FROM new_home THEN
    IF old_home IS NOT NULL AND old_home IS DISTINCT FROM new_home THEN
      UPDATE semantic.identity_home SET generation=generation+1,group_pending=group_pending-old_pending
      WHERE partition_no=old_home;
      old_pending := 0;
    END IF;
    IF new_home IS NOT NULL THEN
      UPDATE semantic.identity_home SET generation=generation+changed::integer,
        group_pending=group_pending+new_pending-old_pending WHERE partition_no=new_home;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER identity_basis_group AFTER INSERT OR DELETE OR UPDATE ON semantic.identity_epoch_group
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_basis_effect();
CREATE TRIGGER identity_basis_redirect AFTER INSERT OR DELETE OR UPDATE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_basis_effect();
CREATE TRIGGER identity_basis_control AFTER INSERT OR DELETE OR UPDATE OF partition_no,published_epoch,pending_job
  ON semantic.identity_epoch_control FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_basis_effect();

CREATE FUNCTION semantic.truncate_identity_basis_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='partition' THEN
    UPDATE semantic.identity_home SET epoch=NULL,node=NULL,write_state=NULL,moved_to=NULL WHERE epoch IS NOT NULL;
  ELSIF TG_TABLE_NAME='identity_epoch_control' THEN
    UPDATE semantic.identity_home SET control_epoch=NULL,control_pending=false
    WHERE partition_no IN (SELECT partition_no FROM semantic.identity_epoch_control);
  ELSIF TG_TABLE_NAME='identity_epoch_group' THEN
    UPDATE semantic.identity_home SET group_pending=0,generation=generation+1
    WHERE partition_no IN (SELECT partition_no FROM semantic.identity_epoch_group);
  ELSE
    UPDATE semantic.identity_home SET generation=generation+1
    WHERE partition_no IN (SELECT route/16 FROM semantic.redirect);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER identity_basis_truncate BEFORE TRUNCATE ON core.partition
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.truncate_identity_basis_source();
CREATE TRIGGER identity_basis_truncate BEFORE TRUNCATE ON semantic.identity_epoch_control
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.truncate_identity_basis_source();
CREATE TRIGGER identity_basis_truncate BEFORE TRUNCATE ON semantic.identity_epoch_group
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.truncate_identity_basis_source();
CREATE TRIGGER identity_basis_truncate BEFORE TRUNCATE ON semantic.redirect
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.truncate_identity_basis_source();

-- Controlled lineage migrations also write native topology in replica mode.
-- The derived rows follow their source writes in that same transaction.
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER identity_basis_topology;
ALTER TABLE semantic.identity_home ENABLE ALWAYS TRIGGER identity_home_basis;
ALTER TABLE semantic.identity_epoch_group ENABLE ALWAYS TRIGGER identity_basis_group;
ALTER TABLE semantic.redirect ENABLE ALWAYS TRIGGER identity_basis_redirect;
ALTER TABLE semantic.identity_epoch_control ENABLE ALWAYS TRIGGER identity_basis_control;
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER identity_basis_truncate;
ALTER TABLE semantic.identity_epoch_group ENABLE ALWAYS TRIGGER identity_basis_truncate;
ALTER TABLE semantic.identity_epoch_control ENABLE ALWAYS TRIGGER identity_basis_truncate;
ALTER TABLE semantic.redirect ENABLE ALWAYS TRIGGER identity_basis_truncate;

-- migrate:down
DROP TRIGGER identity_basis_truncate ON core.partition;
DROP TRIGGER identity_basis_truncate ON semantic.identity_epoch_control;
DROP TRIGGER identity_basis_truncate ON semantic.identity_epoch_group;
DROP TRIGGER identity_basis_truncate ON semantic.redirect;
DROP TRIGGER identity_basis_topology ON core.partition;
DROP TRIGGER identity_basis_control ON semantic.identity_epoch_control;
DROP TRIGGER identity_basis_group ON semantic.identity_epoch_group;
DROP TRIGGER identity_basis_redirect ON semantic.redirect;
DROP FUNCTION semantic.capture_identity_basis_topology();
DROP FUNCTION semantic.capture_identity_basis_effect();
DROP FUNCTION semantic.truncate_identity_basis_source();
DROP TABLE semantic.identity_home;
DROP FUNCTION semantic.update_identity_basis_shard();
DROP TABLE semantic.identity_basis_shard;
