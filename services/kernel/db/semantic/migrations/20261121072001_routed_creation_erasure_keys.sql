-- migrate:up
-- A locator captures its native record in one home. Lead each creation-store lookup
-- with the route, including the generated home route on the Source set and its members.
DROP INDEX semantic.record_source_set_erasure_key;
CREATE UNIQUE INDEX record_source_set_erasure_key ON semantic.record_source_set (route, erasure_key);
DROP INDEX semantic.record_source_set_member_erasure_key;
CREATE UNIQUE INDEX record_source_set_member_erasure_key ON semantic.record_source_set_member (route, erasure_key);
DROP INDEX semantic.subject_erasure_key;
CREATE UNIQUE INDEX subject_erasure_key ON semantic.subject (route, erasure_key);
DROP INDEX semantic.revision_erasure_key;
CREATE UNIQUE INDEX revision_erasure_key ON semantic.revision (route, erasure_key);
DROP INDEX semantic.fact_erasure_key;
CREATE UNIQUE INDEX fact_erasure_key ON semantic.fact (route, erasure_key);
DROP INDEX semantic.identity_epoch_home_gate_erasure_key;
CREATE UNIQUE INDEX identity_epoch_home_gate_erasure_key ON semantic.identity_epoch_home_gate (route, erasure_key);
DROP INDEX semantic.identity_epoch_mapping_erasure_key;
CREATE UNIQUE INDEX identity_epoch_mapping_erasure_key ON semantic.identity_epoch_mapping (route, erasure_key);
-- The two Source-set routes are generated from their home partition.
DO $migration$
DECLARE body text := pg_get_functiondef('semantic.capture_erasure_source_record()'::regprocedure);
BEGIN
  body := replace(body, 'FROM semantic.record_source_set WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key',
    'FROM semantic.record_source_set WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key');
  body := replace(body, 'FROM semantic.record_source_set_member WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key',
    'FROM semantic.record_source_set_member WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key');
  EXECUTE body;
END; $migration$;

-- migrate:down
DROP INDEX semantic.record_source_set_erasure_key;
CREATE UNIQUE INDEX record_source_set_erasure_key ON semantic.record_source_set (erasure_key, route);
DROP INDEX semantic.record_source_set_member_erasure_key;
CREATE UNIQUE INDEX record_source_set_member_erasure_key ON semantic.record_source_set_member (erasure_key, route);
DROP INDEX semantic.subject_erasure_key;
CREATE UNIQUE INDEX subject_erasure_key ON semantic.subject (erasure_key, route);
DROP INDEX semantic.revision_erasure_key;
CREATE UNIQUE INDEX revision_erasure_key ON semantic.revision (erasure_key, route);
DROP INDEX semantic.fact_erasure_key;
CREATE UNIQUE INDEX fact_erasure_key ON semantic.fact (erasure_key, route);
DROP INDEX semantic.identity_epoch_home_gate_erasure_key;
CREATE UNIQUE INDEX identity_epoch_home_gate_erasure_key ON semantic.identity_epoch_home_gate (erasure_key, route);
DROP INDEX semantic.identity_epoch_mapping_erasure_key;
CREATE UNIQUE INDEX identity_epoch_mapping_erasure_key ON semantic.identity_epoch_mapping (erasure_key, route);
-- The two Source-set routes are generated from their home partition.
DO $migration$
DECLARE body text := pg_get_functiondef('semantic.capture_erasure_source_record()'::regprocedure);
BEGIN
  body := replace(body, 'FROM semantic.record_source_set WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key',
    'FROM semantic.record_source_set WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key');
  body := replace(body, 'FROM semantic.record_source_set_member WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key',
    'FROM semantic.record_source_set_member WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key');
  EXECUTE body;
END; $migration$;
