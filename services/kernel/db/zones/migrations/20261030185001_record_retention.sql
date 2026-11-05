-- migrate:up
CREATE TRIGGER zone_record_retention AFTER INSERT OR UPDATE OF state,deleted_at ON zones.zone
 FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_retention();
CREATE INDEX zone_record_retention_due ON zones.zone(route,zone_id) WHERE state='deleted';
INSERT INTO semantic.record_retention_key(partition_no,route,kind,owner_id,record_id,deleted_at)
 SELECT route/16,route,'zone',zone_id,zone_id,deleted_at FROM zones.zone WHERE state='deleted';
INSERT INTO semantic.record_retention_home(partition_no)
 SELECT DISTINCT route/16 FROM zones.zone WHERE state='deleted' ON CONFLICT DO NOTHING;
-- migrate:down
DROP INDEX zones.zone_record_retention_due;
DROP TRIGGER zone_record_retention ON zones.zone;
