-- migrate:up
-- A served read uses the same native pending/summary authority as repair. Old
-- preparations do not acquire this protocol by migration or by a request read.
ALTER TABLE semantic.public_filter_read_definition ADD COLUMN coverage_keys text[];
ALTER TABLE search.public_filter_coverage_preparation ADD COLUMN population_protocol integer
  CHECK (population_protocol IS NULL OR population_protocol=1);
CREATE FUNCTION search.retain_public_filter_population_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.population_protocol IS DISTINCT FROM OLD.population_protocol THEN
    RAISE EXCEPTION 'Original population protocol is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_population_protocol_immutable BEFORE UPDATE
  ON search.public_filter_coverage_preparation FOR EACH ROW
  EXECUTE FUNCTION search.retain_public_filter_population_protocol();
-- Every original baseline retains its current summary. Native adoption writes
-- the baseline before the summary in the same transaction.
ALTER TABLE search.public_filter_coverage_baseline ADD CONSTRAINT public_filter_baseline_current_home
  FOREIGN KEY (partition_no,registration,source_home)
  REFERENCES search.public_filter_coverage_home(partition_no,registration,source_home)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE semantic.public_filter_privacy_head
  ADD COLUMN owner_epoch integer CHECK (owner_epoch>0),
  ADD COLUMN population_fenced boolean NOT NULL DEFAULT true;
UPDATE semantic.public_filter_privacy_head h SET owner_epoch=p.epoch,
  population_fenced=p.write_state<>'active'
FROM core.partition p WHERE p.partition_no=h.partition_no;
CREATE INDEX public_filter_population_fenced ON semantic.public_filter_privacy_head(partition_no)
  WHERE population_fenced;
ALTER TABLE semantic.public_filter_home_enrollment ADD CONSTRAINT public_filter_enrollment_source_head
  FOREIGN KEY (partition_no) REFERENCES semantic.public_filter_privacy_head(partition_no);
ALTER TABLE semantic.public_filter_home_enrollment ADD CONSTRAINT public_filter_enrollment_account_head
  FOREIGN KEY (partition_no) REFERENCES access.account_discovery_population(partition_no);

-- Owner movement cannot disappear from an indexed clean observation. This is an
-- invalidation obligation, never an epoch alias or a handover/repair receipt.
CREATE FUNCTION semantic.fence_public_filter_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.epoch,NEW.write_state) IS DISTINCT FROM (OLD.epoch,OLD.write_state) THEN
    UPDATE semantic.public_filter_privacy_head SET population_fenced=true
      WHERE partition_no=OLD.partition_no;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_population_owner AFTER UPDATE OF epoch,write_state ON core.partition
  FOR EACH ROW EXECUTE FUNCTION semantic.fence_public_filter_population();

CREATE TABLE semantic.public_filter_population_start (
  partition_no integer NOT NULL CHECK (partition_no=0),
  id uuid NOT NULL,
  registration text COLLATE "C" NOT NULL,
  observation text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  read_definition uuid NOT NULL,
  consumer text NOT NULL CHECK (octet_length(consumer)<=8192),
  covered_generation bigint NOT NULL CHECK (covered_generation>=0),
  start_generation bigint NOT NULL CHECK (start_generation>=covered_generation),
  owner_epoch integer NOT NULL CHECK (owner_epoch>0),
  deadline bigint NOT NULL,
  PRIMARY KEY (partition_no,id),
  FOREIGN KEY (partition_no,bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no,bootstrap),
  FOREIGN KEY (partition_no,registration) REFERENCES search.public_filter_registration(partition_no,id),
  FOREIGN KEY (partition_no,observation) REFERENCES search.public_filter_observation(partition_no,observation)
);
CREATE INDEX public_filter_population_start_observation
  ON semantic.public_filter_population_start(partition_no,observation,id);
CREATE FUNCTION semantic.retain_public_filter_population_start() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation_state text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Original population starts are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Erasure uses the original observation's admission lock. Unknown users,
  -- physical copies or children retain this cut, including expired leases.
  SELECT state INTO observation_state FROM search.public_filter_observation
    WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation) FOR UPDATE;
  IF observation_state IS NULL OR observation_state NOT IN ('closing','closed')
    OR EXISTS(SELECT 1 FROM search.public_filter_reference
      WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
    OR EXISTS(SELECT 1 FROM search.public_filter_pit
      WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
    OR EXISTS(SELECT 1 FROM search.public_filter_execution
      WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation)) THEN
    RAISE EXCEPTION 'Original population start is still in use' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER public_filter_population_start_immutable BEFORE UPDATE OR DELETE
  ON semantic.public_filter_population_start FOR EACH ROW
  EXECUTE FUNCTION semantic.retain_public_filter_population_start();

-- Identity and closure are immutable. A previously installed definition can gain
-- its exact compiled key encoding once, through resolve, without changing a cut.
CREATE FUNCTION semantic.retain_public_filter_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.partition_no,NEW.read_definition,NEW.source_id,NEW.configuration,NEW.release_digest,
      NEW.subject_type,NEW.capture_digest,NEW.capture,NEW.dependency_keys) IS DISTINCT FROM
     (OLD.partition_no,OLD.read_definition,OLD.source_id,OLD.configuration,OLD.release_digest,
      OLD.subject_type,OLD.capture_digest,OLD.capture,OLD.dependency_keys)
     OR (OLD.coverage_keys IS NOT NULL AND NEW.coverage_keys IS DISTINCT FROM OLD.coverage_keys) THEN
    RAISE EXCEPTION 'Original public-filter definitions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_definition_immutable BEFORE UPDATE ON semantic.public_filter_read_definition
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_definition();

-- Decode only the existing durable tagged value representation, never authority.
-- Its callers retain the original bounded execution/window byte limits.
CREATE FUNCTION semantic.public_filter_native_json(value jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result jsonb; entry jsonb;
BEGIN
  CASE value->>0
    WHEN 'scalar','value','bigint' THEN RETURN value->1;
    WHEN 'undefined' THEN RETURN 'null'::jsonb;
    WHEN 'array' THEN
      result := '[]'::jsonb;
      FOR entry IN SELECT jsonb_array_elements(value->1) LOOP
        result := result || jsonb_build_array(semantic.public_filter_native_json(entry));
      END LOOP;
      RETURN result;
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR entry IN SELECT jsonb_array_elements(value->1) LOOP
        result := result || jsonb_build_object(entry->>0,semantic.public_filter_native_json(entry->1));
      END LOOP;
      RETURN result;
    ELSE RAISE EXCEPTION 'Invalid native public-filter encoding';
  END CASE;
END $$;

-- A zero position is admitted only from an actual locked native head in the
-- original funded Subject repair command. Missing rows are still unknown.
ALTER TABLE semantic.public_filter_privacy_subject DROP CONSTRAINT public_filter_privacy_subject_position_check;
ALTER TABLE semantic.public_filter_privacy_subject ADD CONSTRAINT public_filter_privacy_subject_position_check
  CHECK (position>=0);

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Population authority cannot be rolled back'; END $$;
