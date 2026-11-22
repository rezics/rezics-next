-- migrate:up
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;

-- A checkout may already have the successor layout before merging this history.
DO $legacy_freshness$
BEGIN
IF EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='search' AND table_name='freshness_home' AND column_name='checkpoint_ceiling') THEN
  RETURN;
END IF;

-- A head advance and checkpoint replay merge on their own home. Keep the home row
-- through resets so ordinary advances can update an existing tuple by primary key.
CREATE TABLE search.freshness_home (
  partition_no integer PRIMARY KEY,
  head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
  checkpoints jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX freshness_uncheckpointed_home ON search.freshness_home (partition_no)
  WHERE head > 0 AND checkpoints = '{}';

-- Names between two caught-up consumers are all behind, including consumers with
-- no checkpoint. Separate ranges allow an exact index seek when most homes agree.
CREATE TYPE search.consumer_range AS RANGE (subtype = text, collation = "C");
CREATE TABLE search.freshness_gap (
  partition_no integer NOT NULL,
  consumers search.consumer_range NOT NULL
);
CREATE INDEX freshness_gap_home ON search.freshness_gap (partition_no);
CREATE INDEX freshness_gap_consumer ON search.freshness_gap USING gist (consumers);

CREATE FUNCTION search.lagging_consumers(head bigint, checkpoints jsonb)
RETURNS search.consumer_multirange LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN head = 0 OR checkpoints = '{}' THEN '{}'::search.consumer_multirange
    ELSE search.consumer_multirange(search.consumer_range(NULL, NULL)) -
      coalesce(range_agg(search.consumer_range(key, key, '[]')), '{}'::search.consumer_multirange)
    END
  FROM jsonb_each_text(checkpoints) WHERE value::bigint >= head
$$;

CREATE FUNCTION search.capture_freshness_gaps() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous search.consumer_multirange := '{}';
  following search.consumer_multirange;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.checkpoints = '{}' AND NEW.checkpoints = '{}' THEN RETURN NULL; END IF;
    previous := search.lagging_consumers(OLD.head, OLD.checkpoints);
  END IF;
  following := search.lagging_consumers(NEW.head, NEW.checkpoints);
  IF previous = following THEN RETURN NULL; END IF;
  IF previous <> '{}' THEN
    DELETE FROM search.freshness_gap WHERE partition_no = NEW.partition_no;
  END IF;
  INSERT INTO search.freshness_gap SELECT NEW.partition_no, unnest(following);
  RETURN NULL;
END
$$;
CREATE TRIGGER freshness_gaps AFTER INSERT OR UPDATE ON search.freshness_home
  FOR EACH ROW EXECUTE FUNCTION search.capture_freshness_gaps();
ALTER TABLE search.freshness_home ENABLE ALWAYS TRIGGER freshness_gaps;

INSERT INTO search.freshness_home (partition_no, head, checkpoints)
SELECT partition_no, coalesce(p.position, 0), coalesce(c.checkpoints, '{}')
FROM core.partition p FULL JOIN (
  SELECT partition_no, jsonb_object_agg(consumer, position) AS checkpoints
  FROM core.consumer_checkpoint WHERE starts_with(consumer, 'search_') AND position > 0
  GROUP BY partition_no
) c USING (partition_no);

CREATE OR REPLACE FUNCTION search.capture_freshness_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'partition' THEN
    IF TG_OP = 'UPDATE' AND (OLD.partition_no, OLD.position) = (NEW.partition_no, NEW.position) THEN RETURN NULL; END IF;
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.partition_no <> NEW.partition_no) THEN
      UPDATE search.freshness_home SET head = 0 WHERE partition_no = OLD.partition_no;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      UPDATE search.freshness_home SET head = NEW.position WHERE partition_no = NEW.partition_no;
      IF NOT FOUND THEN
        INSERT INTO search.freshness_home AS h (partition_no, head) VALUES (NEW.partition_no, NEW.position)
          ON CONFLICT (partition_no) DO UPDATE SET head = EXCLUDED.head;
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND (OLD.partition_no, OLD.consumer, OLD.position) = (NEW.partition_no, NEW.consumer, NEW.position)
      THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND starts_with(OLD.consumer, 'search_') AND OLD.position > 0 AND
       (TG_OP = 'DELETE' OR NEW.position = 0 OR (OLD.partition_no, OLD.consumer) <> (NEW.partition_no, NEW.consumer)) THEN
      UPDATE search.freshness_home SET checkpoints = checkpoints - OLD.consumer WHERE partition_no = OLD.partition_no;
    END IF;
    IF TG_OP <> 'DELETE' AND starts_with(NEW.consumer, 'search_') AND NEW.position > 0 THEN
      INSERT INTO search.freshness_home AS h (partition_no, checkpoints)
        VALUES (NEW.partition_no, jsonb_build_object(NEW.consumer, NEW.position))
        ON CONFLICT (partition_no) DO UPDATE SET checkpoints = h.checkpoints || EXCLUDED.checkpoints;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION search.truncate_freshness_positions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'partition' THEN
    UPDATE search.freshness_home SET head = 0 WHERE head > 0;
  ELSE
    UPDATE search.freshness_home SET checkpoints = '{}' WHERE checkpoints <> '{}';
  END IF;
  RETURN NULL;
END
$$;
DROP TABLE search.freshness_positions;
END
$legacy_freshness$;

-- migrate:down
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;

DO $legacy_freshness$
BEGIN
IF NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='search' AND table_name='freshness_home' AND column_name='checkpoints') THEN
  RETURN;
END IF;
DROP TABLE search.freshness_home, search.freshness_gap;
DROP FUNCTION search.capture_freshness_gaps();
DROP FUNCTION search.lagging_consumers(bigint, jsonb);
DROP TYPE search.consumer_range;
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

CREATE OR REPLACE FUNCTION search.capture_freshness_position() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION search.truncate_freshness_positions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM search.freshness_positions WHERE (consumer = '') = (TG_TABLE_NAME = 'partition');
  RETURN NULL;
END;
$$;
END
$legacy_freshness$;
