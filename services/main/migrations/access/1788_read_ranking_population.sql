-- A materialization revision names applied rows, never a complete source prefix.
CREATE SEQUENCE access.read_ranking_publication_revision;
-- On lineage rebuild, negative historical Review events must be discovered
-- before the first Review population becomes usable. Live removals have the
-- synchronous owner fence below; this horizon is only generation initialization.
ALTER TABLE access.read_ranking_checkpoint ADD COLUMN review_rebuild_position bigint NOT NULL DEFAULT 0;
CREATE TABLE access.read_ranking_publication (
  generation uuid NOT NULL, context text NOT NULL, metric text NOT NULL,
  interval text NOT NULL, bucket date NOT NULL, revision bigint NOT NULL,
  removal_revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(generation,context,metric,interval,bucket)
);
INSERT INTO access.read_ranking_publication
  SELECT generation,context,metric,interval,bucket,
    nextval('access.read_ranking_publication_revision'),0
  FROM (SELECT DISTINCT generation,context,metric,interval,bucket FROM access.read_ranking_admitted) populations;
CREATE FUNCTION access.publish_read_ranking_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.metric='reviews' THEN
      UPDATE access.read_ranking_removal SET generation=NULL
        WHERE generation=OLD.generation AND context=OLD.context AND interval=OLD.interval
          AND bucket=OLD.bucket AND work=OLD.work AND NOT EXISTS (
            SELECT 1 FROM access.read_ranking_admitted a WHERE a.generation=OLD.generation
              AND a.context=OLD.context AND a.metric='reviews' AND a.interval=OLD.interval
              AND a.bucket=OLD.bucket AND a.work=OLD.work);
    END IF;
    INSERT INTO access.read_ranking_publication(generation,context,metric,interval,bucket,revision) VALUES
      (OLD.generation,OLD.context,OLD.metric,OLD.interval,OLD.bucket,nextval('access.read_ranking_publication_revision'))
    ON CONFLICT(generation,context,metric,interval,bucket)
      DO UPDATE SET revision=EXCLUDED.revision;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.metric='reviews' THEN
      UPDATE access.read_ranking_removal SET generation=NEW.generation
        WHERE context=NEW.context AND interval=NEW.interval AND bucket=NEW.bucket
          AND work=NEW.work AND generation IS DISTINCT FROM NEW.generation;
    END IF;
    INSERT INTO access.read_ranking_publication(generation,context,metric,interval,bucket,revision) VALUES
      (NEW.generation,NEW.context,NEW.metric,NEW.interval,NEW.bucket,nextval('access.read_ranking_publication_revision'))
    ON CONFLICT(generation,context,metric,interval,bucket)
      DO UPDATE SET revision=EXCLUDED.revision;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER publish_read_ranking_population AFTER INSERT OR UPDATE OR DELETE ON access.read_ranking_admitted
  FOR EACH ROW EXECUTE FUNCTION access.publish_read_ranking_population();

-- Refresh only changed rows: a score in another metric/bucket must not publish
-- a new revision for an otherwise identical population of the same Work.
CREATE OR REPLACE FUNCTION access.refresh_read_ranking_admission(_work text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  WITH desired AS MATERIALIZED (
    SELECT s.generation,s.metric,s.interval,s.bucket,a.context,s.work,s.score,s.growth
    FROM access.read_ranking_score s JOIN access.read_ranking_admission a USING(work)
    WHERE s.work=_work AND NOT EXISTS(SELECT 1 FROM access.scope_gate g WHERE g.id='work:read:'||a.work AND NOT g.open)
      AND NOT EXISTS(SELECT 1 FROM access.governance_enforcement e WHERE e.owner='graph'
        AND e.resource=a.work AND e.state='restricted' AND e.effect='disclosure'
        AND e.context IN ('urn:rezics:context:global',a.context)
        AND e.component IN ('name','title','record','publication') AND (e.revision IS NULL OR e.revision=a.head))
  ), removed AS (
    DELETE FROM access.read_ranking_admitted r WHERE r.work=_work AND NOT EXISTS (
      SELECT 1 FROM desired d WHERE (d.generation,d.metric,d.interval,d.bucket,d.context,d.work)
        = (r.generation,r.metric,r.interval,r.bucket,r.context,r.work))
  )
  INSERT INTO access.read_ranking_admitted SELECT * FROM desired
  ON CONFLICT(generation,metric,interval,bucket,context,work)
    DO UPDATE SET score=EXCLUDED.score,growth=EXCLUDED.growth
    WHERE (read_ranking_admitted.score,read_ranking_admitted.growth)
      IS DISTINCT FROM (EXCLUDED.score,EXCLUDED.growth);
END $$;

-- Negative Review effects are registered by the source owner before acknowledgement.
-- The following bucket also changes because growth compares with the prior bucket.
CREATE TABLE access.read_ranking_removal (
  event_id bigint NOT NULL REFERENCES access.reader_review_rank_change(id),
  work text NOT NULL, context text NOT NULL, interval text NOT NULL, bucket date NOT NULL,
  generation uuid,
  PRIMARY KEY(context,interval,bucket,event_id)
);
CREATE INDEX read_ranking_removal_work ON access.read_ranking_removal(work,context);
CREATE INDEX read_ranking_removal_population ON access.read_ranking_removal
  (generation,context,interval,bucket,event_id) WHERE generation IS NOT NULL;
CREATE FUNCTION access.publish_read_ranking_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generation IS NOT NULL AND (TG_OP='INSERT' OR NEW.generation IS DISTINCT FROM OLD.generation) THEN
    INSERT INTO access.read_ranking_publication(generation,context,metric,interval,bucket,revision,removal_revision)
      VALUES (NEW.generation,NEW.context,'reviews',NEW.interval,NEW.bucket,0,
        nextval('access.read_ranking_publication_revision'))
    ON CONFLICT(generation,context,metric,interval,bucket)
      DO UPDATE SET removal_revision=EXCLUDED.removal_revision;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER publish_read_ranking_removal AFTER INSERT OR UPDATE OF generation ON access.read_ranking_removal
  FOR EACH ROW EXECUTE FUNCTION access.publish_read_ranking_removal();
CREATE FUNCTION access.register_read_ranking_removal(_id bigint,_work text,_at timestamptz)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO access.read_ranking_removal
    SELECT _id,_work,contexts.context,periods.interval,buckets.bucket,
      CASE WHEN EXISTS (SELECT 1 FROM access.read_ranking_admitted a
        WHERE a.generation=c.generation AND a.context=contexts.context AND a.metric='reviews'
          AND a.interval=periods.interval AND a.bucket=buckets.bucket AND a.work=_work)
        THEN c.generation ELSE NULL END
    FROM (SELECT 'urn:rezics:context:global' AS context UNION
      SELECT context FROM access.read_ranking_admission WHERE work=_work) contexts
    CROSS JOIN (VALUES ('day'),('week'),('month')) periods(interval)
    CROSS JOIN LATERAL (SELECT date_trunc(periods.interval,_at AT TIME ZONE 'UTC')::date AS bucket
      UNION SELECT (date_trunc(periods.interval,_at AT TIME ZONE 'UTC') +
        CASE periods.interval WHEN 'day' THEN INTERVAL '1 day' WHEN 'week' THEN INTERVAL '1 week'
          ELSE INTERVAL '1 month' END)::date) buckets
    LEFT JOIN access.read_ranking_checkpoint c ON c.singleton
    ON CONFLICT DO NOTHING;
$$;
CREATE FUNCTION access.read_ranking_source_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delta < 0 THEN
    PERFORM access.register_read_ranking_removal(NEW.id,NEW.work,NEW.occurred_at);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER read_ranking_source_removal AFTER INSERT ON access.reader_review_rank_change
  FOR EACH ROW EXECUTE FUNCTION access.read_ranking_source_removal();
CREATE FUNCTION access.read_ranking_removal_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.read_ranking_removal(event_id,work,context,interval,bucket)
    SELECT event_id,work,NEW.context,interval,bucket FROM access.read_ranking_removal
      WHERE work=NEW.work AND context='urn:rezics:context:global'
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER read_ranking_removal_context AFTER INSERT ON access.read_ranking_admission
  FOR EACH ROW EXECUTE FUNCTION access.read_ranking_removal_context();
-- Upgrade existing cuts without treating successfully applied targets beyond a
-- failed prefix as pending. Only negative effects not yet applied need a fence.
SELECT access.register_read_ranking_removal(c.id,c.work,c.occurred_at)
  FROM access.reader_review_rank_change c LEFT JOIN access.read_ranking_checkpoint p ON p.singleton
  WHERE c.delta < 0 AND (c.position IS NULL OR p.singleton IS NULL
    OR c.position > p.review_scan_position OR EXISTS (
      SELECT 1 FROM access.read_ranking_pending r
      WHERE r.generation=p.generation AND r.source='review' AND r.position=c.position));
