-- migrate:up
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER freshness_position ON search.freshness_home;
DROP TRIGGER freshness_position ON core.consumer_checkpoint;
DROP TRIGGER freshness_truncate ON core.partition;
DROP TRIGGER freshness_truncate ON core.consumer_checkpoint;
-- Earlier binaries compare opaque shard keys and expand the home keys in each JSON object.
-- Keep their original table and column metadata. A single home per row removes cross-home
-- write conflicts while grouped readers keep their bounded steady-state access.
CREATE TABLE search.freshness_groups (LIKE search.freshness_positions INCLUDING ALL);
INSERT INTO search.freshness_groups SELECT * FROM search.freshness_positions;
TRUNCATE search.freshness_positions;
ALTER TABLE search.freshness_positions ADD COLUMN pending boolean NOT NULL DEFAULT false;
INSERT INTO search.freshness_positions (consumer,shard,positions)
  SELECT consumer,key::integer,jsonb_build_object(key,value)
  FROM search.freshness_groups CROSS JOIN LATERAL jsonb_each(positions);
CREATE INDEX freshness_pending_home ON search.freshness_positions(shard) WHERE consumer='' AND pending;

CREATE FUNCTION search.retain_pending_freshness_home() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE home integer := coalesce(NEW.partition_no,OLD.partition_no);
BEGIN
  IF TG_OP='UPDATE' AND OLD.position=NEW.position THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' AND NEW.position=0 THEN RETURN NULL; END IF;
  INSERT INTO search.freshness_positions(consumer,shard,positions,pending)
    VALUES ('',home,CASE WHEN NEW.position>0 THEN jsonb_build_object(home,NEW.position) ELSE '{}'::jsonb END,true)
    ON CONFLICT (consumer,shard) DO UPDATE SET positions=EXCLUDED.positions,pending=true;
  RETURN NULL;
END;
$$;
CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF head,checkpoint_ceiling
  ON search.freshness_home FOR EACH ROW EXECUTE FUNCTION search.retain_pending_freshness_home();
ALTER TABLE search.freshness_home ENABLE ALWAYS TRIGGER freshness_position;

-- Concurrent commands on different homes never update the same head group. Each pending home overlays its
-- own exact comparison position until a Search checkpoint folds it into the group in one transaction.
CREATE VIEW search.grouped_freshness_positions AS
WITH edits AS (
  SELECT shard / 64 AS shard,
    jsonb_object_agg(shard,positions->shard::text) FILTER (WHERE positions<>'{}'::jsonb) AS added,
    array_agg(shard::text) FILTER (WHERE positions='{}'::jsonb) AS removed
  FROM search.freshness_positions WHERE consumer='' AND pending GROUP BY shard / 64
)
SELECT g.consumer,g.shard,
  CASE WHEN e.shard IS NULL THEN g.positions ELSE
    (g.positions || coalesce(e.added,'{}'::jsonb)) - coalesce(e.removed,'{}'::text[])
  END AS positions
FROM search.freshness_groups g LEFT JOIN edits e ON g.consumer='' AND e.shard=g.shard
WHERE e.removed IS NULL OR (g.positions || coalesce(e.added,'{}'::jsonb)) - e.removed <> '{}'::jsonb
UNION ALL
SELECT ''::text,e.shard,e.added FROM edits e
WHERE e.added IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM search.freshness_groups g WHERE g.consumer='' AND g.shard=e.shard);

CREATE FUNCTION search.write_freshness_slot(who text,home integer,value bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE emptied boolean;
BEGIN
  IF value>0 THEN
    INSERT INTO search.freshness_groups AS g (consumer,shard,positions)
      VALUES (who,home / 64,jsonb_build_object(home,value))
      ON CONFLICT (consumer,shard) DO UPDATE SET positions=g.positions || EXCLUDED.positions;
  ELSE
    UPDATE search.freshness_groups SET positions=positions-home::text
      WHERE consumer=who AND shard=home / 64 RETURNING positions='{}'::jsonb INTO emptied;
    IF emptied THEN DELETE FROM search.freshness_groups WHERE consumer=who AND shard=home / 64; END IF;
  END IF;
END;
$$;
CREATE FUNCTION search.group_freshness_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE folded jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.consumer,OLD.partition_no,OLD.position)=(NEW.consumer,NEW.partition_no,NEW.position) THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' AND OLD.position>0 AND starts_with(OLD.consumer,'search_')
     AND (TG_OP='DELETE' OR NEW.position=0 OR (OLD.consumer,OLD.partition_no)<>(NEW.consumer,NEW.partition_no)) THEN
    DELETE FROM search.freshness_positions WHERE consumer=OLD.consumer AND shard=OLD.partition_no;
    PERFORM search.write_freshness_slot(OLD.consumer,OLD.partition_no,0);
  END IF;
  IF TG_OP<>'DELETE' AND starts_with(NEW.consumer,'search_') THEN
    IF NEW.position>0 THEN
      INSERT INTO search.freshness_positions(consumer,shard,positions)
        VALUES (NEW.consumer,NEW.partition_no,jsonb_build_object(NEW.partition_no,NEW.position))
        ON CONFLICT (consumer,shard) DO UPDATE SET positions=EXCLUDED.positions;
      PERFORM search.write_freshness_slot(NEW.consumer,NEW.partition_no,NEW.position);
    END IF;
    UPDATE search.freshness_positions SET pending=false WHERE consumer='' AND shard=NEW.partition_no AND pending
      RETURNING positions INTO folded;
    IF FOUND THEN
      PERFORM search.write_freshness_slot('',NEW.partition_no,coalesce((folded->>NEW.partition_no::text)::bigint,0));
      IF folded='{}'::jsonb THEN DELETE FROM search.freshness_positions WHERE consumer='' AND shard=NEW.partition_no; END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF consumer,partition_no,position
  ON core.consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION search.group_freshness_checkpoint();
ALTER TABLE core.consumer_checkpoint ENABLE ALWAYS TRIGGER freshness_position;
CREATE FUNCTION search.truncate_freshness_groups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM search.freshness_positions WHERE (consumer='')=(TG_TABLE_NAME='partition');
  DELETE FROM search.freshness_groups WHERE (consumer='')=(TG_TABLE_NAME='partition');
  RETURN NULL;
END;
$$;
CREATE TRIGGER freshness_truncate AFTER TRUNCATE ON core.partition FOR EACH STATEMENT EXECUTE FUNCTION search.truncate_freshness_groups();
CREATE TRIGGER freshness_truncate AFTER TRUNCATE ON core.consumer_checkpoint FOR EACH STATEMENT EXECUTE FUNCTION search.truncate_freshness_groups();
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER freshness_truncate;
ALTER TABLE core.consumer_checkpoint ENABLE ALWAYS TRIGGER freshness_truncate;

-- migrate:down
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER freshness_position ON core.consumer_checkpoint;
DROP TRIGGER freshness_truncate ON core.partition;
DROP TRIGGER freshness_truncate ON core.consumer_checkpoint;
DROP FUNCTION search.truncate_freshness_groups();
DROP FUNCTION search.group_freshness_checkpoint();
DROP FUNCTION search.write_freshness_slot(text,integer,bigint);
DROP VIEW search.grouped_freshness_positions;
TRUNCATE search.freshness_positions;
ALTER TABLE search.freshness_positions DROP COLUMN pending;
INSERT INTO search.freshness_positions SELECT * FROM search.freshness_groups WHERE consumer<>'';
DROP TABLE search.freshness_groups;
INSERT INTO search.freshness_positions(consumer,shard,positions)
  SELECT '',partition_no / 64,jsonb_object_agg(partition_no,position) FROM search.freshness_home
  WHERE position>0 GROUP BY partition_no / 64;
DROP TRIGGER freshness_position ON search.freshness_home;
DROP FUNCTION search.retain_pending_freshness_home();
CREATE TRIGGER freshness_position AFTER INSERT OR UPDATE OF head,checkpoint_ceiling
  ON search.freshness_home FOR EACH ROW EXECUTE FUNCTION search.capture_freshness_position();
CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF consumer,partition_no,position
  ON core.consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION search.capture_freshness_position();
CREATE TRIGGER freshness_truncate AFTER TRUNCATE ON core.partition
  FOR EACH STATEMENT EXECUTE FUNCTION search.truncate_freshness_positions();
CREATE TRIGGER freshness_truncate AFTER TRUNCATE ON core.consumer_checkpoint
  FOR EACH STATEMENT EXECUTE FUNCTION search.truncate_freshness_positions();
ALTER TABLE search.freshness_home ENABLE ALWAYS TRIGGER freshness_position;
ALTER TABLE core.consumer_checkpoint ENABLE ALWAYS TRIGGER freshness_position;
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER freshness_truncate;
ALTER TABLE core.consumer_checkpoint ENABLE ALWAYS TRIGGER freshness_truncate;
