-- migrate:up
-- This lock is the cutover barrier: all old total writes finish before installation.
-- Keep every existing total unchanged; only new committed counted deltas enter the streams.
LOCK TABLE rating.population_total_component IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION rating.require_population_total_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR (NEW.count, NEW.sum) IS DISTINCT FROM (OLD.count, OLD.sum))
     AND current_setting('rating.population_total_writer', true) IS DISTINCT FROM 'population-home-v1' THEN
    RAISE EXCEPTION 'Rating population totals require population-home delivery';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER population_total_delivery_writer
  BEFORE INSERT OR UPDATE ON rating.population_total_component
  FOR EACH ROW EXECUTE FUNCTION rating.require_population_total_delivery();
ALTER TABLE rating.population_total_component ENABLE ALWAYS TRIGGER population_total_delivery_writer;

CREATE TABLE rating.population_total_clock (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  generation bigint NOT NULL CHECK (generation > 0),
  pending bigint NOT NULL CHECK (pending >= 0)
);

-- Target-local, one ordered stream per destination population. No target baseline is needed.
CREATE TABLE rating.population_total_source (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  population_id uuid NOT NULL,
  serial bigint NOT NULL CHECK (serial > 0),
  PRIMARY KEY (partition_no, population_id)
);
CREATE TABLE rating.population_total_delivery (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  population_id uuid NOT NULL,
  serial bigint NOT NULL CHECK (serial > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  pending boolean NOT NULL DEFAULT true,
  PRIMARY KEY (partition_no, population_id, serial)
);
CREATE INDEX population_total_delivery_pending_idx
  ON rating.population_total_delivery (partition_no, population_id, serial) WHERE pending;

-- Destination-local contiguous receipt frontier. A missing stream starts at serial 1 by protocol,
-- never by interpreting a missing predecessor's contribution as zero.
CREATE TABLE rating.population_total_received (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  population_id uuid NOT NULL,
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  serial bigint NOT NULL DEFAULT 0 CHECK (serial >= 0),
  PRIMARY KEY (route, population_id, source_partition),
  CHECK (route = get_byte(uuid_send(population_id), 10) * 256 + get_byte(uuid_send(population_id), 11))
);
CREATE TABLE rating.population_total_inbox (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  population_id uuid NOT NULL,
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  serial bigint NOT NULL CHECK (serial > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, population_id, source_partition, serial),
  CHECK (route = get_byte(uuid_send(population_id), 10) * 256 + get_byte(uuid_send(population_id), 11))
);

-- migrate:down
-- Forward only: receipts, source serials and retained baseline must survive restarts.
SELECT 1;
