-- migrate:up
ALTER TABLE zones.zone ADD COLUMN deletion_generation uuid;
ALTER TABLE zones.zone ADD COLUMN deletion_transaction_id uuid;
CREATE FUNCTION zones.record_purge_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='deleted' AND OLD.state='active' THEN
  NEW.deletion_generation:=gen_random_uuid();NEW.deletion_transaction_id:=NEW.transaction_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER zone_record_purge_generation BEFORE UPDATE ON zones.zone
 FOR EACH ROW EXECUTE FUNCTION zones.record_purge_generation();
CREATE CONSTRAINT TRIGGER zone_record_purge_commit AFTER UPDATE ON zones.zone
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.resource_record_purge_commit();
CREATE TRIGGER zone_record_purge_gate BEFORE UPDATE OR DELETE ON zones.zone
 FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();
CREATE CONSTRAINT TRIGGER zone_record_purge_writer AFTER INSERT OR UPDATE ON zones.zone
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();

-- migrate:down
-- Retained custody must be resolved before removing this schema.
