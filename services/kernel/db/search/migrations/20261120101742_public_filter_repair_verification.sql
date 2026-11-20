-- migrate:up
CREATE TABLE search.public_filter_repair_verification (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  execution text COLLATE "C" NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  progress text CHECK (octet_length(progress)<=16384),
  PRIMARY KEY (partition_no,observation,execution),
  FOREIGN KEY (partition_no,observation,execution)
    REFERENCES search.public_filter_execution(partition_no,observation,id) ON DELETE CASCADE
);

CREATE TABLE search.public_filter_repair_subject (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  execution text COLLATE "C" NOT NULL,
  subject uuid NOT NULL,
  home integer NOT NULL,
  revision bigint NOT NULL,
  pending_source text,
  page integer,
  item integer,
  position bigint,
  completion bigint,
  PRIMARY KEY (partition_no,observation,execution,subject),
  FOREIGN KEY (partition_no,observation,execution)
    REFERENCES search.public_filter_repair_verification(partition_no,observation,execution)
);
CREATE INDEX public_filter_repair_subject_winners ON search.public_filter_repair_subject
  (partition_no,observation,execution,revision,home,subject) WHERE page IS NOT NULL;
CREATE INDEX public_filter_repair_subject_pending ON search.public_filter_repair_subject
  (partition_no,observation,execution,revision) WHERE pending_source IS NOT NULL;

-- Any edit to the original evidence retires its proof. The normal producer has no proof
-- row to update until its closed execution is first verified.
CREATE FUNCTION search.invalidate_public_filter_repair_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE search.public_filter_repair_verification SET revision=revision+1,progress=NULL
    WHERE (partition_no,observation,execution)=(OLD.partition_no,OLD.observation,OLD.execution);
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      (OLD.partition_no,OLD.observation,OLD.execution)<>(NEW.partition_no,NEW.observation,NEW.execution)) THEN
    UPDATE search.public_filter_repair_verification SET revision=revision+1,progress=NULL
    WHERE (partition_no,observation,execution)=(NEW.partition_no,NEW.observation,NEW.execution);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER public_filter_repair_page_revision AFTER INSERT OR UPDATE OR DELETE ON search.public_filter_repair_page
FOR EACH ROW EXECUTE FUNCTION search.invalidate_public_filter_repair_evidence();
CREATE TRIGGER public_filter_repair_effect_revision AFTER INSERT OR UPDATE OR DELETE ON search.public_filter_repair_effect
FOR EACH ROW EXECUTE FUNCTION search.invalidate_public_filter_repair_evidence();

-- A bounded guard for all homes touched during a native winner pass. The empty target
-- is reserved for Core owner epoch/state changes. Lanes keep independent writer homes
-- from sharing a single transaction lock. Counters are created by writes, including
-- writes made before the reader first visits a target.
CREATE TABLE search.public_filter_repair_authority (
  physical_target text COLLATE "C" NOT NULL,
  lane integer NOT NULL CHECK (lane BETWEEN 0 AND 3),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  PRIMARY KEY (physical_target,lane)
);
INSERT INTO search.public_filter_repair_authority(physical_target,lane)
SELECT target,lane FROM unnest(ARRAY['','@source','@accounts']) target CROSS JOIN generate_series(0,3) lane;

CREATE FUNCTION search.advance_public_filter_repair_authority(target text, home integer) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO search.public_filter_repair_authority AS a(physical_target,lane,revision) VALUES (target,home%4,1)
  ON CONFLICT (physical_target,lane) DO UPDATE SET revision=a.revision+1
$$;

CREATE FUNCTION search.mark_public_filter_repair_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
      (OLD.physical_target,OLD.partition_no)<>(NEW.physical_target,NEW.partition_no)) THEN
    PERFORM search.advance_public_filter_repair_authority(OLD.physical_target,OLD.partition_no);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM search.advance_public_filter_repair_authority(NEW.physical_target,NEW.partition_no);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER public_filter_repair_writer_revision AFTER INSERT OR UPDATE OR DELETE ON search.identity_writer
FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_writer();
CREATE TRIGGER public_filter_repair_gate_revision AFTER INSERT OR DELETE OR UPDATE OF
  partition_no,physical_target,consumer,incarnation,owner_epoch,write_alias,closed_token,enrollment_generation,fence_generation
ON search.identity_writer_gate FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_writer();

CREATE FUNCTION search.mark_public_filter_repair_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM search.advance_public_filter_repair_authority('',NEW.partition_no);
  RETURN NULL;
END
$$;
CREATE TRIGGER public_filter_repair_owner_revision AFTER UPDATE OF epoch,write_state,position ON core.partition
FOR EACH ROW WHEN (OLD.epoch IS DISTINCT FROM NEW.epoch OR OLD.write_state IS DISTINCT FROM NEW.write_state
  OR NEW.position < OLD.position)
EXECUTE FUNCTION search.mark_public_filter_repair_owner();

-- Source verifies exact dependencies at each page. Subsequent changes to native
-- heads or a retained projection invalidate that pass before it authorizes ACK.
-- Account changes are independent of Subject-only settlement.
CREATE FUNCTION search.mark_public_filter_repair_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM search.advance_public_filter_repair_authority(TG_ARGV[0],OLD.partition_no);
  ELSE
    PERFORM search.advance_public_filter_repair_authority(TG_ARGV[0],NEW.partition_no);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER public_filter_repair_source_revision AFTER UPDATE OF position,owner_epoch ON semantic.public_filter_privacy_head
FOR EACH ROW WHEN (OLD.position IS DISTINCT FROM NEW.position OR OLD.owner_epoch IS DISTINCT FROM NEW.owner_epoch)
EXECUTE FUNCTION search.mark_public_filter_repair_source_change('@source');
CREATE TRIGGER public_filter_repair_projection_build_revision AFTER UPDATE OR DELETE ON semantic.public_filter_projection_build
FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_source_change('@source');
CREATE TRIGGER public_filter_repair_projection_head_revision AFTER UPDATE OR DELETE ON semantic.public_filter_projection_head
FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_source_change('@source');
CREATE TRIGGER public_filter_repair_account_revision AFTER UPDATE OF revision,claim_revision ON access.account_discovery_population
FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision OR OLD.claim_revision IS DISTINCT FROM NEW.claim_revision)
EXECUTE FUNCTION search.mark_public_filter_repair_source_change('@accounts');

CREATE FUNCTION search.mark_public_filter_repair_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM search.advance_public_filter_repair_authority(OLD.prefix||'discovery-g'||OLD.generation,OLD.route/16);
  ELSE
    PERFORM search.advance_public_filter_repair_authority(NEW.prefix||'discovery-g'||NEW.generation,NEW.route/16);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER public_filter_repair_copy_revision AFTER INSERT OR UPDATE OR DELETE ON search.discovery_copy
FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_copy();

-- Discovery's native allocation also has a mutable SQL identity.
CREATE FUNCTION search.mark_public_filter_repair_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM search.advance_public_filter_repair_authority(OLD.prefix||'discovery-g'||OLD.generation,0);
  IF TG_OP = 'UPDATE' AND (OLD.prefix,OLD.generation)<>(NEW.prefix,NEW.generation) THEN
    PERFORM search.advance_public_filter_repair_authority(NEW.prefix||'discovery-g'||NEW.generation,0);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER public_filter_repair_allocation_revision AFTER DELETE OR UPDATE OF prefix,generation,index_uuid,incarnation,state
ON search.discovery_generation FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_allocation();

-- migrate:down
DROP TRIGGER public_filter_repair_allocation_revision ON search.discovery_generation;
DROP FUNCTION search.mark_public_filter_repair_allocation();
DROP TRIGGER public_filter_repair_copy_revision ON search.discovery_copy;
DROP FUNCTION search.mark_public_filter_repair_copy();
DROP TRIGGER public_filter_repair_account_revision ON access.account_discovery_population;
DROP TRIGGER public_filter_repair_projection_head_revision ON semantic.public_filter_projection_head;
DROP TRIGGER public_filter_repair_projection_build_revision ON semantic.public_filter_projection_build;
DROP TRIGGER public_filter_repair_source_revision ON semantic.public_filter_privacy_head;
DROP FUNCTION search.mark_public_filter_repair_source_change();
DROP TRIGGER public_filter_repair_owner_revision ON core.partition;
DROP FUNCTION search.mark_public_filter_repair_owner();
DROP TRIGGER public_filter_repair_gate_revision ON search.identity_writer_gate;
DROP TRIGGER public_filter_repair_writer_revision ON search.identity_writer;
DROP FUNCTION search.mark_public_filter_repair_writer();
DROP FUNCTION search.advance_public_filter_repair_authority(text,integer);
DROP TABLE search.public_filter_repair_authority;
DROP TRIGGER public_filter_repair_effect_revision ON search.public_filter_repair_effect;
DROP TRIGGER public_filter_repair_page_revision ON search.public_filter_repair_page;
DROP FUNCTION search.invalidate_public_filter_repair_evidence();
DROP TABLE search.public_filter_repair_subject;
DROP TABLE search.public_filter_repair_verification;
