-- migrate:up
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;

-- The empty consumer is the shared outbox head. An absent home has position zero.
-- One row holds at most 64 native bigint positions, including for a densely used home range.
CREATE TABLE search.freshness_positions (
  consumer text NOT NULL CHECK (consumer = '' OR starts_with(consumer, 'search_')),
  shard integer NOT NULL CHECK (shard >= 0),
  positions jsonb NOT NULL CHECK (jsonb_typeof(positions) = 'object'),
  PRIMARY KEY (consumer, shard)
);

INSERT INTO search.freshness_positions
SELECT '', partition_no / 64, jsonb_object_agg(partition_no, position)
FROM core.partition WHERE position > 0 GROUP BY partition_no / 64
UNION ALL
SELECT consumer, partition_no / 64, jsonb_object_agg(partition_no, position)
FROM core.consumer_checkpoint WHERE position > 0 AND starts_with(consumer, 'search_')
GROUP BY consumer, partition_no / 64;

CREATE FUNCTION search.capture_freshness_position() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_consumer text := '';
  new_consumer text := '';
  emptied boolean;
BEGIN
  IF TG_TABLE_NAME = 'consumer_checkpoint' THEN
    old_consumer := OLD.consumer;
    new_consumer := NEW.consumer;
    IF NOT (coalesce(starts_with(old_consumer, 'search_'), false)
         OR coalesce(starts_with(new_consumer, 'search_'), false)) THEN RETURN NULL; END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (old_consumer, OLD.partition_no, OLD.position)
      IS NOT DISTINCT FROM (new_consumer, NEW.partition_no, NEW.position) THEN RETURN NULL; END IF;

  IF TG_OP <> 'INSERT' AND OLD.position > 0 AND (old_consumer = '' OR starts_with(old_consumer, 'search_'))
      AND (TG_OP = 'DELETE' OR NEW.position = 0
           OR (old_consumer, OLD.partition_no) IS DISTINCT FROM (new_consumer, NEW.partition_no)) THEN
    UPDATE search.freshness_positions SET positions = positions - OLD.partition_no::text
      WHERE consumer = old_consumer AND shard = OLD.partition_no / 64
      RETURNING positions = '{}'::jsonb INTO emptied;
    IF emptied THEN
      DELETE FROM search.freshness_positions WHERE consumer = old_consumer AND shard = OLD.partition_no / 64;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.position > 0 AND (new_consumer = '' OR starts_with(new_consumer, 'search_')) THEN
    INSERT INTO search.freshness_positions AS retained (consumer, shard, positions)
      VALUES (new_consumer, NEW.partition_no / 64, jsonb_build_object(NEW.partition_no, NEW.position))
      ON CONFLICT (consumer, shard) DO UPDATE SET positions = retained.positions || EXCLUDED.positions;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF partition_no, position
  ON core.partition FOR EACH ROW EXECUTE FUNCTION search.capture_freshness_position();
CREATE TRIGGER freshness_position AFTER INSERT OR DELETE OR UPDATE OF consumer, partition_no, position
  ON core.consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION search.capture_freshness_position();

CREATE FUNCTION search.truncate_freshness_positions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM search.freshness_positions WHERE (consumer = '') = (TG_TABLE_NAME = 'partition');
  RETURN NULL;
END;
$$;
CREATE TRIGGER freshness_truncate AFTER TRUNCATE ON core.partition
  FOR EACH STATEMENT EXECUTE FUNCTION search.truncate_freshness_positions();
CREATE TRIGGER freshness_truncate AFTER TRUNCATE ON core.consumer_checkpoint
  FOR EACH STATEMENT EXECUTE FUNCTION search.truncate_freshness_positions();

ALTER TABLE core.partition ENABLE ALWAYS TRIGGER freshness_position;
ALTER TABLE core.consumer_checkpoint ENABLE ALWAYS TRIGGER freshness_position;
ALTER TABLE core.partition ENABLE ALWAYS TRIGGER freshness_truncate;
ALTER TABLE core.consumer_checkpoint ENABLE ALWAYS TRIGGER freshness_truncate;

-- migrate:down
DROP TRIGGER freshness_position ON core.partition;
DROP TRIGGER freshness_position ON core.consumer_checkpoint;
DROP TRIGGER freshness_truncate ON core.partition;
DROP TRIGGER freshness_truncate ON core.consumer_checkpoint;
DROP FUNCTION search.capture_freshness_position();
DROP FUNCTION search.truncate_freshness_positions();
DROP TABLE search.freshness_positions;
