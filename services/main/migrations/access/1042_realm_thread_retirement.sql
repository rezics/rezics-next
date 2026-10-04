-- Retire derived history cuts through the same durable invalidation queue.
-- Keep every pre-existing dirty kind when widening this shared CHECK.
ALTER TABLE access.realm_thread_dirty DROP CONSTRAINT realm_thread_dirty_kind_check;
ALTER TABLE access.realm_thread_dirty ADD CHECK(kind IN ('reply','work','realm','parent','population'));
CREATE INDEX realm_history_admission_cut ON access.realm_history_admission(data_epoch,sequence,kind,membership_id,generation);

-- A deleted reference cannot leave an exact-key history job behind forever.
DELETE FROM access.realm_thread_population_job j WHERE NOT EXISTS (
  SELECT 1 FROM access.realm_thread_reference r
  WHERE (r.data_epoch,r.realm,r.reply)=(j.data_epoch,j.realm,j.reply));
ALTER TABLE access.realm_thread_population_job ADD FOREIGN KEY(data_epoch,realm,reply)
  REFERENCES access.realm_thread_reference ON DELETE CASCADE;

CREATE FUNCTION access.queue_realm_population_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _realm text;
BEGIN
  IF TG_TABLE_NAME='realm_thread_dirty' THEN
    IF NEW.kind<>'realm' THEN RETURN NULL; END IF;
    _realm:=NEW.resource;
  ELSIF TG_TABLE_NAME='realm_thread_population' THEN
    _realm:=NEW.realm;
  ELSE
    IF TG_OP='DELETE' THEN
      IF OLD.kind<>'realm' THEN RETURN NULL; END IF;
      _realm:=OLD.owner_subject;
    ELSE
      IF NEW.kind<>'realm' THEN RETURN NULL; END IF;
      _realm:=NEW.owner_subject;
    END IF;
  END IF;
  INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
    SELECT DISTINCT data_epoch,'population',_realm FROM access.realm_thread_population WHERE realm=_realm
    ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key='';
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_population_realm_changed AFTER INSERT OR UPDATE ON access.realm_thread_dirty
  FOR EACH ROW EXECUTE FUNCTION access.queue_realm_population_retirement();
CREATE TRIGGER realm_thread_population_created AFTER INSERT ON access.realm_thread_population
  FOR EACH ROW EXECUTE FUNCTION access.queue_realm_population_retirement();
CREATE TRIGGER realm_thread_population_member_changed AFTER INSERT OR UPDATE OR DELETE ON access.membership
  FOR EACH ROW EXECUTE FUNCTION access.queue_realm_population_retirement();
CREATE TRIGGER realm_thread_population_private_member_changed AFTER INSERT OR UPDATE OR DELETE ON access.private_membership
  FOR EACH ROW EXECUTE FUNCTION access.queue_realm_population_retirement();
INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
  SELECT DISTINCT data_epoch,'population',realm FROM access.realm_thread_population
  ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key='';

-- Removal must propagate the same parent invalidation as changed admission.
CREATE OR REPLACE FUNCTION access.realm_thread_parent_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _epoch text; _reply text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.thread,OLD.active) IS NOT DISTINCT FROM (NEW.thread,NEW.active) THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='DELETE' THEN _epoch:=OLD.data_epoch; _reply:=OLD.reply;
  ELSE _epoch:=NEW.data_epoch; _reply:=NEW.reply; END IF;
  INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource)
    SELECT _epoch,'parent',_reply WHERE EXISTS(SELECT 1 FROM access.realm_thread_reference child
      WHERE child.data_epoch=_epoch AND child.parent=_reply LIMIT 1)
    ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key='';
  RETURN NULL;
END $$;
CREATE TRIGGER realm_thread_parent_deleted AFTER DELETE ON access.realm_thread_reference
  FOR EACH ROW EXECUTE FUNCTION access.realm_thread_parent_changed();
