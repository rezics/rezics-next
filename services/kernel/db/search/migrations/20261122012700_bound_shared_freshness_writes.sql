-- migrate:up
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;

-- Every current checkpoint on this home is at most the retained ceiling. Above
-- it, ceiling + 1 compares exactly like the native head, including against an
-- absent checkpoint at zero. The branch also permits a maximal bigint ceiling.
CREATE TABLE search.freshness_home (
  partition_no integer PRIMARY KEY CHECK (partition_no >= 0),
  head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
  checkpoint_ceiling bigint NOT NULL DEFAULT 0 CHECK (checkpoint_ceiling >= 0),
  position bigint GENERATED ALWAYS AS (
    CASE WHEN head > checkpoint_ceiling THEN checkpoint_ceiling + 1 ELSE head END
  ) STORED
);
INSERT INTO search.freshness_home(partition_no, head, checkpoint_ceiling)
SELECT p.partition_no, p.position, coalesce(c.ceiling, 0)
FROM core.partition p LEFT JOIN (
  SELECT partition_no, max(position) AS ceiling FROM core.consumer_checkpoint GROUP BY partition_no
) c USING (partition_no);

DELETE FROM search.freshness_positions WHERE consumer = '';
INSERT INTO search.freshness_positions(consumer, shard, positions)
SELECT '', partition_no / 64, jsonb_object_agg(partition_no, position)
FROM search.freshness_home WHERE position > 0 GROUP BY partition_no / 64;

CREATE FUNCTION search.maintain_freshness_home() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    -- Truncating core.partition also requires truncating its referencing checkpoints.
    TRUNCATE search.freshness_home;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.partition_no, OLD.position) = (NEW.partition_no, NEW.position) THEN RETURN NULL; END IF;

  IF TG_TABLE_NAME = 'consumer_checkpoint' THEN
    -- All native consumers count, including those read via the generic fallback.
    -- An observed ceiling never decreases, so a covered checkpoint needs no row lock.
    IF NEW.position > 0 THEN
      INSERT INTO search.freshness_home AS h(partition_no, checkpoint_ceiling)
      SELECT NEW.partition_no, NEW.position WHERE NOT EXISTS (
        SELECT 1 FROM search.freshness_home prior
        WHERE prior.partition_no = NEW.partition_no AND prior.checkpoint_ceiling >= NEW.position
      )
      ON CONFLICT (partition_no) DO UPDATE SET checkpoint_ceiling = EXCLUDED.checkpoint_ceiling
        WHERE h.checkpoint_ceiling < EXCLUDED.checkpoint_ceiling;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.partition_no <> NEW.partition_no) THEN
      UPDATE search.freshness_home SET head = 0 WHERE partition_no = OLD.partition_no AND head <> 0;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      INSERT INTO search.freshness_home AS h(partition_no, head) VALUES (NEW.partition_no, NEW.position)
      ON CONFLICT (partition_no) DO UPDATE SET head = EXCLUDED.head WHERE h.head <> EXCLUDED.head;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- The original group writer still handles exact Search checkpoints and omits
-- equal positions. Only the source of its shared head changes.
DROP TRIGGER freshness_position ON core.partition;
CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF partition_no, position
  ON core.partition FOR EACH ROW EXECUTE FUNCTION search.maintain_freshness_home();
CREATE TRIGGER freshness_ceiling AFTER INSERT OR UPDATE OF partition_no, position
  ON core.consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION search.maintain_freshness_home();
CREATE TRIGGER freshness_position AFTER INSERT OR UPDATE OF head, checkpoint_ceiling
  ON search.freshness_home FOR EACH ROW EXECUTE FUNCTION search.capture_freshness_position();
CREATE TRIGGER freshness_home_truncate AFTER TRUNCATE
  ON core.partition FOR EACH STATEMENT EXECUTE FUNCTION search.maintain_freshness_home();
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER freshness_position;
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER freshness_home_truncate;
ALTER TABLE core.consumer_checkpoint ENABLE ALWAYS TRIGGER freshness_ceiling;
ALTER TABLE search.freshness_home ENABLE ALWAYS TRIGGER freshness_position;

-- migrate:down
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER freshness_home_truncate ON core.partition;
DROP TRIGGER freshness_ceiling ON core.consumer_checkpoint;
DROP TRIGGER freshness_position ON core.partition;
CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF partition_no, position
  ON core.partition FOR EACH ROW EXECUTE FUNCTION search.capture_freshness_position();
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER freshness_position;

-- Restore even the committed heads that grew without another shared write.
DELETE FROM search.freshness_positions WHERE consumer = '';
INSERT INTO search.freshness_positions(consumer, shard, positions)
SELECT '', partition_no / 64, jsonb_object_agg(partition_no, position)
FROM core.partition WHERE position > 0 GROUP BY partition_no / 64;

DROP TABLE search.freshness_home;
DROP FUNCTION search.maintain_freshness_home();
