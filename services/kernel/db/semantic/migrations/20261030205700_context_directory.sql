-- migrate:up
-- The native Context remains the Source. Its pending bit is an exact-key outbox bridge, not a permission index.
ALTER TABLE semantic.context ADD COLUMN directory_pending boolean NOT NULL DEFAULT true;
CREATE INDEX context_directory_pending ON semantic.context(route,erasure_key) WHERE directory_pending;
CREATE INDEX context_directory_bootstrap ON semantic.context(route,erasure_key);

CREATE TABLE semantic.context_directory_entry (
  route integer NOT NULL DEFAULT 0 CHECK(route=0),
  context_id uuid NOT NULL,
  language text NOT NULL,
  search_key text COLLATE "C" NOT NULL,
  state text NOT NULL CHECK(state IN ('active','deleted')),
  source_epoch integer NOT NULL,
  source_version bigint NOT NULL,
  refresh_pending boolean NOT NULL DEFAULT false,
  recorded_transaction_id uuid NOT NULL,
  erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
  PRIMARY KEY(route,context_id,language),
  UNIQUE(route,erasure_key)
);
CREATE INDEX context_directory_raw ON semantic.context_directory_entry(route,state,context_id) WHERE language='';
CREATE INDEX context_directory_prefix ON semantic.context_directory_entry(route,state,search_key,context_id,language);
CREATE INDEX context_directory_refresh ON semantic.context_directory_entry(route,context_id) WHERE refresh_pending;
-- One technical coverage frontier for each installed native home. No actor or payload enters progress.
CREATE TABLE semantic.context_directory_home (
  route integer NOT NULL,
  partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL,
  after_route integer NOT NULL,
  after_key bigint NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false,
  erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
  PRIMARY KEY(route), UNIQUE(route,erasure_key),
  CHECK(route=partition_no*16),
  CHECK(after_route BETWEEN route AND route+16)
);
CREATE INDEX context_directory_preparing ON semantic.context_directory_home(complete,route) WHERE NOT complete;
INSERT INTO semantic.context_directory_home(route,partition_no,source_epoch,after_route)
  SELECT partition_no*16,partition_no,epoch,partition_no*16 FROM core.partition;
-- Empty installed homes have a native bounded absence proof at migration's exclusive writer cut.
UPDATE semantic.context_directory_home h SET complete=true,after_route=route+16
 WHERE NOT EXISTS(SELECT 1 FROM semantic.context c WHERE c.route BETWEEN h.route AND h.route+15 LIMIT 1);

CREATE FUNCTION semantic.context_directory_invalidate_home() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.write_state IS DISTINCT FROM OLD.write_state THEN
   UPDATE semantic.context_directory_home SET complete=false,source_epoch=NEW.epoch,
     after_route=NEW.partition_no*16,after_key=0 WHERE route=NEW.partition_no*16;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER context_directory_home_change AFTER UPDATE OF epoch,write_state ON core.partition
 FOR EACH ROW EXECUTE FUNCTION semantic.context_directory_invalidate_home();

CREATE FUNCTION semantic.context_directory_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.labels IS DISTINCT FROM OLD.labels OR NEW.state IS DISTINCT FROM OLD.state)
    AND NEW.security_revision=OLD.security_revision THEN
   NEW.security_revision:=OLD.security_revision+1;
 END IF;
 IF TG_OP='INSERT' OR NEW.labels IS DISTINCT FROM OLD.labels OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.security_revision IS DISTINCT FROM OLD.security_revision
    OR (NEW.directory_pending AND NOT OLD.directory_pending) THEN
   NEW.directory_pending:=true;
   UPDATE semantic.context_directory_home SET complete=false,after_route=least(after_route,NEW.route),after_key=0
     WHERE route=(NEW.route/16)*16;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER context_directory_dirty BEFORE INSERT OR UPDATE ON semantic.context
 FOR EACH ROW EXECUTE FUNCTION semantic.context_directory_dirty();

CREATE FUNCTION semantic.capture_context_directory_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 -- Reject delayed copies after the genuine local participant fence, for every inherited role.
 IF EXISTS(SELECT 1 FROM semantic.erasure_copy_role r
   JOIN semantic.erasure_home h ON h.partition_no=r.partition_no AND h.account_id=r.account_id
   WHERE r.partition_no=0 AND r.store='context_directory_entry' AND r.record_key=NEW.erasure_key
     AND r.transaction_id=NEW.recorded_transaction_id) THEN
   RAISE EXCEPTION 'context_directory_actor_fenced';
 END IF;
 PERFORM semantic.capture_erasure_roles(0,'context_directory_entry',NEW.erasure_key,NEW.recorded_transaction_id);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER context_directory_entry_erasure AFTER INSERT OR UPDATE ON semantic.context_directory_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_directory_entry();

CREATE FUNCTION semantic.context_directory_owner_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; id uuid; role text;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD.route; id:=OLD.resource_id; role:=OLD.grant_role;
 ELSE r:=NEW.route; id:=NEW.resource_id; role:=NEW.grant_role; END IF;
 IF role='semantic.context.owner' THEN
   UPDATE semantic.context SET directory_pending=true,security_revision=security_revision+1 WHERE route=r AND context_id=id;
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER context_directory_owner_dirty AFTER INSERT OR UPDATE OR DELETE ON access.resource_role_grant
 FOR EACH ROW EXECUTE FUNCTION semantic.context_directory_owner_dirty();

-- The existing sealed all-role Source producer receives the real new physical stores at the same native commit.
CREATE FUNCTION semantic.capture_context_directory_source_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.store='context_directory_entry' THEN
   SELECT true,context_id INTO NEW.native_present,NEW.context_id
     FROM semantic.context_directory_entry WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key;
   NEW.native_present:=coalesce(NEW.native_present,false);
 ELSIF NEW.store='context_directory_home' THEN
   SELECT true INTO NEW.native_present FROM semantic.context_directory_home
     WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key;
   NEW.native_present:=coalesce(NEW.native_present,false);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER context_directory_source_record BEFORE INSERT ON semantic.erasure_source_record
 FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_directory_source_record();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context_directory_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();

-- migrate:down
DROP TRIGGER erasure_source_removed ON semantic.context_directory_entry;
DROP TRIGGER context_directory_source_record ON semantic.erasure_source_record;
DROP FUNCTION semantic.capture_context_directory_source_record();
DROP TRIGGER context_directory_owner_dirty ON access.resource_role_grant;
DROP FUNCTION semantic.context_directory_owner_dirty();
DROP TRIGGER context_directory_entry_erasure ON semantic.context_directory_entry;
DROP FUNCTION semantic.capture_context_directory_entry();
DROP TRIGGER context_directory_dirty ON semantic.context;
DROP FUNCTION semantic.context_directory_dirty();
DROP TRIGGER context_directory_home_change ON core.partition;
DROP FUNCTION semantic.context_directory_invalidate_home();
DROP TABLE semantic.context_directory_home;
DROP TABLE semantic.context_directory_entry;
DROP INDEX semantic.context_directory_bootstrap;
DROP INDEX semantic.context_directory_pending;
ALTER TABLE semantic.context DROP COLUMN directory_pending;
