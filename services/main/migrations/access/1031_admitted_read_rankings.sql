-- Rank only an admitted population. Rejected scores never precede its seek.
CREATE TABLE access.read_ranking_admission (
  work text NOT NULL,
  context text NOT NULL,
  head text NOT NULL,
  main_version text NOT NULL,
  PRIMARY KEY(work,context)
);
CREATE TABLE access.read_ranking_admitted (
  generation uuid NOT NULL,
  metric text NOT NULL,
  interval text NOT NULL,
  bucket date NOT NULL,
  context text NOT NULL,
  work text NOT NULL,
  score bigint NOT NULL,
  growth bigint NOT NULL,
  PRIMARY KEY(generation,metric,interval,bucket,context,work)
);
CREATE INDEX read_ranking_admitted_score ON access.read_ranking_admitted
  (generation,metric,interval,bucket,context,score DESC,work);
CREATE INDEX read_ranking_admitted_growth ON access.read_ranking_admitted
  (generation,metric,interval,bucket,context,growth DESC,work) WHERE growth>0;
CREATE INDEX read_ranking_work ON access.read_ranking_score(work);

CREATE FUNCTION access.refresh_read_ranking_admission(_work text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM access.read_ranking_admitted WHERE work=_work;
  INSERT INTO access.read_ranking_admitted
    SELECT s.generation,s.metric,s.interval,s.bucket,a.context,s.work,s.score,s.growth
    FROM access.read_ranking_score s JOIN access.read_ranking_admission a USING(work)
    WHERE s.work=_work AND NOT EXISTS(SELECT 1 FROM access.scope_gate g WHERE g.id='work:read:'||a.work AND NOT g.open)
      AND NOT EXISTS(SELECT 1 FROM access.governance_enforcement e WHERE e.owner='graph'
        AND e.resource=a.work AND e.state='restricted' AND e.effect='disclosure'
        AND e.context IN ('urn:rezics:context:global',a.context)
        AND e.component IN ('name','title','record','publication') AND (e.revision IS NULL OR e.revision=a.head));
END $$;
CREATE FUNCTION access.read_ranking_score_admission_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN PERFORM access.refresh_read_ranking_admission(OLD.work); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM access.refresh_read_ranking_admission(NEW.work); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER read_ranking_score_admission_changed AFTER INSERT OR UPDATE OR DELETE ON access.read_ranking_score
  FOR EACH ROW EXECUTE FUNCTION access.read_ranking_score_admission_changed();
CREATE FUNCTION access.read_ranking_fence_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _old text; _new text;
BEGIN
  IF TG_TABLE_NAME='scope_gate' THEN
    IF TG_OP<>'INSERT' AND OLD.id LIKE 'work:read:%' THEN _old:=substr(OLD.id,11); END IF;
    IF TG_OP<>'DELETE' AND NEW.id LIKE 'work:read:%' THEN _new:=substr(NEW.id,11); END IF;
  ELSE
    IF TG_OP<>'INSERT' AND OLD.owner='graph' THEN _old:=OLD.resource; END IF;
    IF TG_OP<>'DELETE' AND NEW.owner='graph' THEN _new:=NEW.resource; END IF;
  END IF;
  IF _old IS NOT NULL THEN PERFORM access.refresh_read_ranking_admission(_old); END IF;
  IF _new IS NOT NULL AND _new IS DISTINCT FROM _old THEN PERFORM access.refresh_read_ranking_admission(_new); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER read_ranking_governance_changed AFTER INSERT OR UPDATE OR DELETE ON access.governance_enforcement
  FOR EACH ROW EXECUTE FUNCTION access.read_ranking_fence_changed();
CREATE TRIGGER read_ranking_scope_changed AFTER INSERT OR UPDATE OR DELETE ON access.scope_gate
  FOR EACH ROW EXECUTE FUNCTION access.read_ranking_fence_changed();
