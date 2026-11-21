-- migrate:up
-- These authored records allocate consecutive erasure keys across independent command homes.
-- Read their native receipt by the same home and key that the locator actually retains.
CREATE INDEX subject_erasure_home_lookup ON semantic.subject ((route/16),erasure_key);
CREATE INDEX revision_erasure_home_lookup ON semantic.revision ((route/16),erasure_key);
CREATE INDEX fact_erasure_home_lookup ON semantic.fact ((route/16),erasure_key);
CREATE INDEX identity_epoch_mapping_erasure_home_lookup ON semantic.identity_epoch_mapping ((route/16),erasure_key);
CREATE INDEX identity_epoch_home_gate_erasure_home_lookup ON semantic.identity_epoch_home_gate ((route/16),erasure_key);

DO $migration$
DECLARE
  definition text := pg_get_functiondef('semantic.capture_erasure_source_record()'::regprocedure);
  store text;
  before text;
  after text;
BEGIN
  FOREACH store IN ARRAY ARRAY['subject','revision','fact','identity_epoch_mapping','identity_epoch_home_gate'] LOOP
    before := format('FROM semantic.%I r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;',store);
    after := format('FROM semantic.%I r WHERE r.erasure_key=NEW.record_key AND r.route/16=NEW.partition_no;',store);
    IF strpos(definition,before)=0 THEN RAISE EXCEPTION 'Missing native % Source lookup',store; END IF;
    definition := replace(definition,before,after);
  END LOOP;
  EXECUTE definition;
END; $migration$;

-- migrate:down
DO $migration$
DECLARE
  definition text := pg_get_functiondef('semantic.capture_erasure_source_record()'::regprocedure);
  store text;
  before text;
  after text;
BEGIN
  FOREACH store IN ARRAY ARRAY['subject','revision','fact','identity_epoch_mapping','identity_epoch_home_gate'] LOOP
    before := format('FROM semantic.%I r WHERE r.erasure_key=NEW.record_key AND r.route/16=NEW.partition_no;',store);
    after := format('FROM semantic.%I r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;',store);
    IF strpos(definition,before)=0 THEN RAISE EXCEPTION 'Missing native % Source lookup',store; END IF;
    definition := replace(definition,before,after);
  END LOOP;
  EXECUTE definition;
END; $migration$;

DROP INDEX semantic.subject_erasure_home_lookup;
DROP INDEX semantic.revision_erasure_home_lookup;
DROP INDEX semantic.fact_erasure_home_lookup;
DROP INDEX semantic.identity_epoch_mapping_erasure_home_lookup;
DROP INDEX semantic.identity_epoch_home_gate_erasure_home_lookup;
