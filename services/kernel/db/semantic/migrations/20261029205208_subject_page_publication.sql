-- migrate:up
-- Fixed partition metadata, never a globally scanned application work queue.
CREATE TABLE semantic.subject_page_work_home (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  pending integer NOT NULL CHECK (pending >= 0)
);
INSERT INTO semantic.subject_page_work_home
SELECT p, (SELECT count(*) FROM semantic.subject_page_bootstrap b WHERE b.partition_no=p AND b.state<>'done')
 + (SELECT count(*) FROM semantic.subject_page_repair r WHERE r.route>=p*16 AND r.route<(p+1)*16 AND r.state<>'done')
 + (SELECT count(*) FROM semantic.subject_page_fanout f WHERE f.route>=p*16 AND f.route<(p+1)*16 AND f.state<>'done')
FROM generate_series(0,4095) p;
CREATE FUNCTION semantic.subject_page_work_home_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE home integer; delta integer;
BEGIN
  IF TG_TABLE_NAME='subject_page_bootstrap' THEN home := NEW.partition_no; ELSE home := NEW.route >> 4; END IF;
  delta := CASE WHEN NEW.state<>'done' THEN 1 ELSE 0 END;
  IF TG_OP='UPDATE' THEN delta := delta-CASE WHEN OLD.state<>'done' THEN 1 ELSE 0 END; END IF;
  IF delta<>0 THEN UPDATE semantic.subject_page_work_home SET pending=pending+delta WHERE partition_no=home; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subject_page_repair_work_home AFTER INSERT OR UPDATE OF state ON semantic.subject_page_repair
FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_work_home_changed();
CREATE TRIGGER subject_page_fanout_work_home AFTER INSERT OR UPDATE OF state ON semantic.subject_page_fanout
FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_work_home_changed();
CREATE TRIGGER subject_page_bootstrap_work_home AFTER INSERT OR UPDATE OF state ON semantic.subject_page_bootstrap
FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_work_home_changed();
CREATE INDEX fact_publication_descriptive ON semantic.fact(route,subject_id,slot_id,log_seq) WHERE NOT relation;
CREATE INDEX fact_publication_relations ON semantic.fact(route,subject_id,slot_id,log_seq) WHERE relation;
CREATE INDEX subject_page_component_witness ON semantic.subject_page_component(route,subject_id,generation,component_kind,component_key)
WHERE shown AND component_kind<>'label';
-- migrate:down
DROP TRIGGER subject_page_bootstrap_work_home ON semantic.subject_page_bootstrap;
DROP TRIGGER subject_page_fanout_work_home ON semantic.subject_page_fanout;
DROP TRIGGER subject_page_repair_work_home ON semantic.subject_page_repair;
DROP FUNCTION semantic.subject_page_work_home_changed();
DROP TABLE semantic.subject_page_work_home;
DROP INDEX semantic.fact_publication_descriptive;
DROP INDEX semantic.fact_publication_relations;
DROP INDEX semantic.subject_page_component_witness;
