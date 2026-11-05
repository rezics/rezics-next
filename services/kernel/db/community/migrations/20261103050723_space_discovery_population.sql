-- migrate:up
-- This is an internal candidate census, never an anonymous disclosure count.
-- Backfill once under the migration lock; runtime readers only seek one row.
LOCK TABLE community.space IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE community.space_discovery_population (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  population bigint NOT NULL CHECK (population >= 0)
);
INSERT INTO community.space_discovery_population (partition_no, population)
SELECT p, count(s.space_id)
FROM generate_series(0,4095) p
LEFT JOIN community.space s ON (s.route >> 4) = p
GROUP BY p;

CREATE FUNCTION community.maintain_space_discovery_population() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE community.space_discovery_population SET population = population +
    CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END
    WHERE partition_no = (COALESCE(NEW.route, OLD.route) >> 4);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Space discovery census is unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER space_discovery_population AFTER INSERT OR DELETE ON community.space
FOR EACH ROW EXECUTE FUNCTION community.maintain_space_discovery_population();

CREATE FUNCTION community.reset_space_discovery_population() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE community.space_discovery_population SET population = 0;
  RETURN NULL;
END;
$$;
CREATE TRIGGER space_discovery_population_truncate AFTER TRUNCATE ON community.space
FOR EACH STATEMENT EXECUTE FUNCTION community.reset_space_discovery_population();

-- migrate:down
-- Forward only: the generation census is retained with native identities.
