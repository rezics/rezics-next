-- migrate:up
ALTER TABLE search.public_filter_coverage_preparation ADD COLUMN ack_protocol smallint NOT NULL DEFAULT 0
  CHECK (ack_protocol IN (0,1));
CREATE UNIQUE INDEX public_filter_ack_protocol_cut ON search.public_filter_coverage_preparation(bootstrap)
  WHERE ack_protocol=1;
CREATE FUNCTION search.retain_public_filter_ack_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT FROM semantic.public_filter_bootstrap b WHERE (b.partition_no,b.bootstrap)=(0,OLD.bootstrap)
    AND b.state<>'aborted') THEN
    RAISE EXCEPTION 'An original live preparation retains its ACK protocol' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER public_filter_ack_protocol_retained BEFORE DELETE ON search.public_filter_coverage_preparation
  FOR EACH ROW WHEN (OLD.ack_protocol=1) EXECUTE FUNCTION search.retain_public_filter_ack_protocol();
CREATE TRIGGER public_filter_ack_protocol_immutable BEFORE UPDATE OF ack_protocol ON search.public_filter_coverage_preparation
  FOR EACH ROW WHEN (OLD.ack_protocol IS DISTINCT FROM NEW.ack_protocol) EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- A retained range contains only native locators and hashes. Its address includes the
-- revision of the evidence compared. Older revisions remain available for historical readback.
CREATE TABLE search.public_filter_ack_range (
  partition_no integer NOT NULL CHECK (partition_no=0),
  job uuid NOT NULL,
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  binding text NOT NULL CHECK (binding ~ '^[0-9a-f]{64}$'),
  first_home integer NOT NULL CHECK (first_home BETWEEN 0 AND 4095),
  width integer NOT NULL CHECK (width IN (1,2,4,8,16,32,64,128,256,512,1024,2048,4096)),
  identity_digest bytea NOT NULL,
  witness bytea NOT NULL CHECK (octet_length(witness)=32),
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  digest bytea NOT NULL CHECK (octet_length(digest)=32),
  predecessor text NOT NULL,
  enrollment_root text NOT NULL,
  left_child uuid REFERENCES search.public_filter_ack_range(revision),
  right_child uuid REFERENCES search.public_filter_ack_range(revision),
  PRIMARY KEY (partition_no,job,binding,first_home,width,witness),
  UNIQUE (revision),
  CHECK (first_home%width=0),
  CHECK ((left_child IS NULL)=(right_child IS NULL) AND (width<=16 OR left_child IS NOT NULL)),
  FOREIGN KEY (partition_no,job) REFERENCES search.generation_publication(partition_no,job) ON DELETE CASCADE,
  FOREIGN KEY (partition_no,registration,bootstrap) REFERENCES search.public_filter_coverage_preparation ON DELETE CASCADE
);
CREATE TRIGGER public_filter_ack_range_immutable BEFORE UPDATE ON search.public_filter_ack_range
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- Verification progress may restart for a later privacy or writer obligation.
-- Only a mutation of the actual page/effect evidence changes this revision.
ALTER TABLE search.public_filter_repair_verification ADD COLUMN evidence_revision bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION search.invalidate_public_filter_repair_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE search.public_filter_repair_verification SET revision=revision+1,evidence_revision=evidence_revision+1,progress=NULL
    WHERE (partition_no,observation,execution)=(OLD.partition_no,OLD.observation,OLD.execution);
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      (OLD.partition_no,OLD.observation,OLD.execution)<>(NEW.partition_no,NEW.observation,NEW.execution)) THEN
    UPDATE search.public_filter_repair_verification SET revision=revision+1,evidence_revision=evidence_revision+1,progress=NULL
    WHERE (partition_no,observation,execution)=(NEW.partition_no,NEW.observation,NEW.execution);
  END IF;
  RETURN NULL;
END
$$;
CREATE TABLE search.public_filter_ack_manifest (
  partition_no integer NOT NULL CHECK (partition_no=0),
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  job uuid NOT NULL,
  version smallint NOT NULL DEFAULT 1 CHECK (version=1),
  root_revision uuid NOT NULL REFERENCES search.public_filter_ack_range(revision),
  root_digest bytea NOT NULL CHECK (octet_length(root_digest)=32),
  generation bigint NOT NULL,
  enrollment_root text NOT NULL,
  owner_epoch integer NOT NULL,
  physical_target text COLLATE "C" NOT NULL,
  incarnation text NOT NULL,
  observation text COLLATE "C" NOT NULL,
  execution text COLLATE "C" NOT NULL,
  terminal uuid NOT NULL,
  binding text NOT NULL,
  ordinal bigint NOT NULL,
  terminal_root text NOT NULL,
  settlement text NOT NULL,
  settlement_digest bytea NOT NULL,
  evidence_revision bigint NOT NULL,
  identity_digest bytea NOT NULL,
  continuity bytea NOT NULL,
  committed_by xid8 NOT NULL,
  PRIMARY KEY (partition_no,registration,bootstrap),
  UNIQUE (partition_no,job),
  FOREIGN KEY (partition_no,job) REFERENCES search.generation_publication(partition_no,job),
  FOREIGN KEY (partition_no,registration,bootstrap) REFERENCES search.public_filter_coverage_preparation,
  FOREIGN KEY (partition_no,observation,execution) REFERENCES search.public_filter_execution,
  FOREIGN KEY (partition_no,observation,execution) REFERENCES search.public_filter_repair_verification,
  FOREIGN KEY (partition_no,bootstrap,execution,terminal) REFERENCES semantic.public_filter_repair_step
);
CREATE TRIGGER public_filter_ack_manifest_immutable BEFORE UPDATE OR DELETE ON search.public_filter_ack_manifest
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- Source retention/identity loss invalidates historical readback. Ordinary privacy
-- positions, native enqueues and writer settlement only invalidate the current comparison.
INSERT INTO search.public_filter_repair_authority (physical_target,lane)
SELECT '@ack-retention',lane FROM generate_series(0,3) lane;

CREATE TRIGGER public_filter_ack_privacy_loss AFTER DELETE ON semantic.public_filter_privacy_head
  FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_source_change('@ack-retention');
CREATE TRIGGER public_filter_ack_population_loss AFTER DELETE ON access.account_discovery_population
  FOR EACH ROW EXECUTE FUNCTION search.mark_public_filter_repair_source_change('@ack-retention');

-- Only an explicitly pinned preparation has a clock. The root row exists before
-- any comparison and serializes changes even to a previously untouched subtree.
CREATE TABLE search.public_filter_ack_home_clock (
  partition_no integer NOT NULL CHECK (partition_no=0),
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  first_home integer NOT NULL,
  width integer NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  continuity bigint NOT NULL DEFAULT 0,
  incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (bootstrap,first_home,width),
  FOREIGN KEY (partition_no,registration,bootstrap) REFERENCES search.public_filter_coverage_preparation ON DELETE CASCADE
);
CREATE FUNCTION search.begin_public_filter_ack_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(NEW.partition_no,NEW.registration,NEW.bootstrap,0,4096);
  RETURN NULL;
END $$;
CREATE TRIGGER public_filter_ack_clock_pin AFTER INSERT ON search.public_filter_coverage_preparation
  FOR EACH ROW WHEN (NEW.ack_protocol=1) EXECUTE FUNCTION search.begin_public_filter_ack_clock();

CREATE FUNCTION search.public_filter_ack_range_witness(cut uuid, first_no integer, span integer, foreign_cut bytea)
RETURNS bytea LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE
  gate_id uuid;
  lifetime bigint;
  local_cut bytea;
BEGIN
  SELECT incarnation,continuity INTO gate_id,lifetime FROM search.public_filter_ack_home_clock
    WHERE (bootstrap,first_home,width)=(cut,0,4096) FOR SHARE;
  -- A fresh statement snapshot sees a mutation which released the gate while
  -- this read waited. Repeatable-read callers retry on serialization failure.
  SELECT uuid_send(incarnation)||int8send(revision) INTO local_cut FROM search.public_filter_ack_home_clock
    WHERE (bootstrap,first_home,width)=(cut,first_no/greatest(span,16)*greatest(span,16),greatest(span,16));
  RETURN sha256(foreign_cut||uuid_send(gate_id)||int8send(lifetime)||local_cut);
END $$;

CREATE FUNCTION search.lose_public_filter_ack_cut(cut uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE search.public_filter_ack_home_clock SET continuity=continuity+1,revision=revision+1
    WHERE (bootstrap,first_home,width)=(cut,0,4096)
$$;
CREATE FUNCTION search.public_filter_ack_receipt_loss() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM search.lose_public_filter_ack_cut(OLD.bootstrap);
  RETURN NULL;
END $$;
CREATE FUNCTION search.public_filter_ack_checkpoint_loss() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumer ~ '^public_filter_[0-9a-f]{32}$' THEN
    PERFORM search.lose_public_filter_ack_cut(substring(OLD.consumer FROM 15)::uuid);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER public_filter_ack_checkpoint_loss AFTER DELETE OR UPDATE OF epoch,position,partition_no,consumer
  ON core.consumer_checkpoint FOR EACH ROW EXECUTE FUNCTION search.public_filter_ack_checkpoint_loss();

CREATE TRIGGER public_filter_ack_enrollment_loss AFTER DELETE ON semantic.public_filter_home_enrollment
  FOR EACH ROW EXECUTE FUNCTION search.public_filter_ack_receipt_loss();
CREATE TRIGGER public_filter_ack_baseline_loss AFTER DELETE ON search.public_filter_coverage_baseline
  FOR EACH ROW EXECUTE FUNCTION search.public_filter_ack_receipt_loss();
ALTER TABLE search.public_filter_coverage_home ADD COLUMN baseline_delta boolean;
CREATE INDEX public_filter_ack_delta ON search.public_filter_coverage_home(partition_no,registration,source_home)
  WHERE baseline_delta;
CREATE FUNCTION search.classify_public_filter_ack_home() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b search.public_filter_coverage_baseline%ROWTYPE;
BEGIN
  -- A NULL marker has no staged comparison. Leave v0 and unvisited v1
  -- homes out of the delta index; a full manifest requires every marker.
  IF TG_OP='INSERT' THEN NEW.baseline_delta := NULL; RETURN NEW; END IF;
  IF OLD.baseline_delta IS NOT NULL THEN
    IF TG_OP='DELETE' OR
      (NEW.partition_no,NEW.registration,NEW.source_home,NEW.source_epoch,NEW.baseline_bootstrap) IS DISTINCT FROM
      (OLD.partition_no,OLD.registration,OLD.source_home,OLD.source_epoch,OLD.baseline_bootstrap) THEN
      PERFORM search.lose_public_filter_ack_cut(OLD.baseline_bootstrap);
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      NEW.baseline_delta := NULL;
      RETURN NEW;
    END IF;
    IF (NEW.relevant_position,NEW.native_enqueue_revision,NEW.native_revision,NEW.native_claim_revision,
      NEW.acknowledged_position,NEW.acknowledged_native_enqueue,NEW.acknowledged_baseline,NEW.acknowledged_settlement,
      NEW.acknowledged_native_revision,NEW.acknowledged_native_claim_revision,NEW.last_change_generation)
      IS DISTINCT FROM (OLD.relevant_position,OLD.native_enqueue_revision,OLD.native_revision,OLD.native_claim_revision,
      OLD.acknowledged_position,OLD.acknowledged_native_enqueue,OLD.acknowledged_baseline,OLD.acknowledged_settlement,
      OLD.acknowledged_native_revision,OLD.acknowledged_native_claim_revision,OLD.last_change_generation) THEN
      INSERT INTO search.public_filter_ack_home_clock AS h(partition_no,registration,bootstrap,first_home,width,revision)
        SELECT 0,OLD.registration,OLD.baseline_bootstrap,OLD.source_home/span*span,span,1
        FROM unnest(ARRAY[4096,2048,1024,512,256,128,64,32,16]) span ORDER BY span DESC
        ON CONFLICT (bootstrap,first_home,width) DO UPDATE SET revision=h.revision+1;
    END IF;
  ELSIF TG_OP='DELETE' THEN RETURN OLD;
  ELSIF NEW.baseline_delta IS NULL THEN RETURN NEW;
  END IF;
  SELECT base.* INTO b FROM search.public_filter_coverage_preparation c
    JOIN search.public_filter_coverage_baseline base USING(partition_no,registration,bootstrap)
    WHERE (c.partition_no,c.registration,c.bootstrap)=(NEW.partition_no,NEW.registration,NEW.baseline_bootstrap)
      AND c.ack_protocol=1 AND base.source_home=NEW.source_home AND base.source_epoch=NEW.source_epoch;
  IF NOT FOUND THEN NEW.baseline_delta := NULL; RETURN NEW; END IF;
  NEW.baseline_delta := NEW.relevant_position>b.source_position
    OR NEW.native_enqueue_revision>b.native_enqueue_revision
    OR NEW.native_revision IS DISTINCT FROM b.native_revision
    OR NEW.native_claim_revision IS DISTINCT FROM b.native_claim_revision;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_ack_home_delta BEFORE INSERT OR DELETE OR UPDATE ON search.public_filter_coverage_home
  FOR EACH ROW EXECUTE FUNCTION search.classify_public_filter_ack_home();

-- Bind preparation and adoption to the actual cold catalogue job and its retained Search/Source rows.
CREATE VIEW search.public_filter_ack_authority AS
SELECT j.partition_no,j.job,j.phase,j.fence,j.fenced_pass,j.pass,j.physical_target,j.native_incarnation AS incarnation,
  o.registration,b.bootstrap,o.observation,x.id AS execution,b.read_definition,d.release_digest,p.epoch AS owner_epoch,
  c.generation,c.root AS enrollment_root,r.coverage_generation,x.repair_settlement,
  sha256(convert_to(jsonb_build_array(j.binding,j.consumer,b.consumer,b.source_position,b.owner_epoch,
    r.consumer,r.definition,o.queried,o.covered,o.prepared_build,o.prepared_generation,x.execution,
    d.source_id,d.configuration,d.capture_digest,d.release_digest,d.dependency_keys,d.coverage_keys)::text,'UTF8')) AS identity_digest
FROM search.generation_publication j
JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.publication_job)=(j.partition_no,j.job)
  AND b.publication_execution=j.job::text AND b.publication_observation=b.queried
  AND b.snapshot_kind='prepared' AND b.state='adopted' AND b.coverage_sealed AND b.coverage_after=4096 AND b.account_after=4096
JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(b.partition_no,b.queried)
  AND o.consumer_bootstrap='0:'||b.bootstrap::text AND o.prepared_build=o.consumer_bootstrap AND o.state='open'
JOIN search.public_filter_execution x ON (x.partition_no,x.observation,x.id)=(o.partition_no,o.observation,b.publication_execution)
JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
  AND r.state='active' AND r.physical_target=j.physical_target
JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=(r.partition_no,r.physical_target,j.native_incarnation)
JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(b.partition_no,b.read_definition)
  AND d.read_definition::text=j.binding->>'readDefinition' AND d.release_digest=j.consumer->>'meaningDigest'
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(d.partition_no,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=b.owner_epoch AND p.epoch=s.owner_epoch AND p.write_state='active'
JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(r.partition_no,r.id,b.bootstrap)
  AND c.ack_protocol=1 AND c.population_protocol=1 AND c.after_home=4096 AND c.definition=d.read_definition
  AND c.generation=b.coverage_generation AND c.root=b.coverage_root AND c.consumer=r.consumer
WHERE j.partition_no=0 AND j.source_home=0 AND j.family='subjects' AND '["scope","catalogue-text"]'=ANY(d.coverage_keys)
  AND (j.observation IS NULL OR j.observation=o.observation)
  AND (j.bootstrap IS NULL OR (j.bootstrap,j.queried,j.execution)=(o.consumer_bootstrap,o.queried,x.id));

-- Existing Search revision lanes serialize the repair verifier with foreign owners.
-- All four rows for each named authority must exist. Hold the same locks to commit.
CREATE FUNCTION search.public_filter_ack_witness(targets text[]) RETURNS bytea LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN count(*)=4*cardinality(targets) THEN
    sha256(convert_to(jsonb_agg(jsonb_build_array(physical_target,lane,revision) ORDER BY physical_target,lane)::text,'UTF8')) END
  FROM (SELECT * FROM search.public_filter_repair_authority WHERE physical_target=ANY(targets)
    ORDER BY physical_target,lane FOR SHARE) locked
$$;

-- Extract one field of the original tagged custody object. All callers below only
-- decode independently verified, immutable step state or the fenced Search execution.
CREATE FUNCTION search.public_filter_ack_field(obj jsonb, field_name text) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT entry->1->1 FROM jsonb_array_elements(obj) entry WHERE entry->>0=field_name
$$;
-- The verifier can re-fence the same closed settlement on a subsequent native
-- transaction and refresh. All original state and physical fence bindings remain exact.
CREATE FUNCTION search.public_filter_ack_settlement_digest(state jsonb) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT sha256(convert_to(jsonb_build_array(
    (SELECT jsonb_agg(entry ORDER BY entry->>0) FROM jsonb_array_elements(state) entry WHERE entry->>0<>'fence'),
    (SELECT jsonb_agg(entry ORDER BY entry->>0) FROM jsonb_array_elements(search.public_filter_ack_field(state,'fence')) entry
      WHERE entry->>0 NOT IN ('transaction','refresh'))
  )::text,'UTF8'))
$$;
CREATE FUNCTION search.public_filter_ack_window(step_state text, home integer)
RETURNS TABLE(epoch integer,base bigint,through_pos bigint,receipt text) LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  body jsonb := step_state::jsonb->1;
  input jsonb := search.public_filter_ack_field(body,'input');
  batch jsonb := search.public_filter_ack_field(body,'windowBatch');
  bridge jsonb;
  following jsonb;
  packed bytea;
  idx integer;
  members integer;
BEGIN
  IF search.public_filter_ack_field(input,'phase')='"window"' AND batch IS NOT NULL THEN
    idx := home-(search.public_filter_ack_field(batch,'from')::integer);
    members := search.public_filter_ack_field(batch,'count')::integer;
    IF idx NOT BETWEEN 0 AND members-1 OR members NOT BETWEEN 1 AND 128 THEN RETURN; END IF;
    packed := decode(search.public_filter_ack_field(batch,'packed')#>>'{}','base64');
    IF length(packed)<>44*members THEN RETURN; END IF;
    epoch := ('x'||encode(substring(packed FROM idx*44+1 FOR 4),'hex'))::bit(32)::integer;
    base := ('x'||encode(substring(packed FROM idx*44+5 FOR 8),'hex'))::bit(64)::bigint;
    receipt := encode(substring(packed FROM idx*44+13 FOR 32),'hex');
    IF search.public_filter_ack_field(batch,'through') IS NULL THEN through_pos := base;
    ELSE through_pos := (search.public_filter_ack_field(batch,'through')->idx->>1)::bigint; END IF;
  ELSIF search.public_filter_ack_field(input,'phase')='"bridge"' THEN
    bridge := search.public_filter_ack_field(input,'bridge');
    following := search.public_filter_ack_field(body,'next');
    IF (search.public_filter_ack_field(bridge,'partition')::integer=home AND
      search.public_filter_ack_field(following,'phase')='"window"' AND
      search.public_filter_ack_field(following,'partition')::integer=home+1) IS NOT TRUE THEN RETURN; END IF;
    epoch := search.public_filter_ack_field(bridge,'epoch')::integer;
    base := (search.public_filter_ack_field(bridge,'base')#>>'{}')::bigint;
    through_pos := (search.public_filter_ack_field(bridge,'through')#>>'{}')::bigint;
    receipt := search.public_filter_ack_field(bridge,'receipt')#>>'{}';
  ELSE RETURN;
  END IF;
  IF epoch>0 AND base>=0 AND through_pos>=base AND receipt ~ '^[0-9a-f]{64}$' THEN RETURN NEXT; END IF;
END $$;

-- Compute every receipt in the receiver. INSERT accepts only a native job, verified
-- chain binding and aligned interval. A parent reads both immutable children.
CREATE FUNCTION search.compare_public_filter_ack_range() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  l search.public_filter_ack_range%ROWTYPE;
  r search.public_filter_ack_range%ROWTYPE;
  homes integer;
  chain_ok boolean;
  foreign_cut bytea;
  child_cut bytea;
  previous_node search.public_filter_ack_range%ROWTYPE;
BEGIN
  IF NEW.partition_no<>0 OR NEW.first_home NOT BETWEEN 0 AND 4095 OR NEW.width NOT IN
    (1,2,4,8,16,32,64,128,256,512,1024,2048,4096) OR NEW.first_home%NEW.width<>0 THEN
    RAISE EXCEPTION 'Invalid receiver interval' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority
    WHERE job=NEW.job AND phase='reconciled' AND pass=1 AND NOT fenced_pass AND fence IS NULL;
  NEW.registration := a.registration;
  NEW.bootstrap := a.bootstrap;
  NEW.revision := gen_random_uuid();
  NEW.identity_digest := a.identity_digest;
  IF NEW.width<=16 AND NEW.left_child IS NULL AND NEW.right_child IS NULL THEN
    UPDATE search.public_filter_coverage_home h SET baseline_delta=true
    WHERE (h.partition_no,h.registration,h.baseline_bootstrap)=(0,a.registration,a.bootstrap)
      AND h.source_home>=NEW.first_home AND h.source_home<NEW.first_home+NEW.width AND h.baseline_delta IS NULL;
  END IF;
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(0,a.registration,a.bootstrap,NEW.first_home/greatest(NEW.width,16)*greatest(NEW.width,16),greatest(NEW.width,16))
    ON CONFLICT DO NOTHING;
  foreign_cut := search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']);
  NEW.witness := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width,foreign_cut);
  IF NEW.width<=16 AND NEW.left_child IS NULL AND NEW.right_child IS NULL THEN
    WITH members AS MATERIALIZED (
      SELECT i.home,w.step,w.verified_root,w.verified_ordinal,win.through_pos,b.predecessor,b.root,
        b.receipt,b.creation_position,b.source_epoch,b.source_position,b.native_enqueue_revision,
        b.native_revision,b.native_claim_revision,h.acknowledged_position,h.acknowledged_native_enqueue,
        h.relevant_position,h.native_enqueue_revision AS current_enqueue,h.native_revision AS current_revision,
        h.native_claim_revision AS current_claim,h.last_change_generation,h.baseline_delta,
        ph.position AS privacy_position,ac.revision AS account_revision,ac.claim_revision AS account_claim
      FROM generate_series(NEW.first_home,NEW.first_home+NEW.width-1) i(home)
      CROSS JOIN LATERAL (
        SELECT s.step,s.state,s.verified_root,s.verified_ordinal FROM semantic.public_filter_repair_step s
        WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_binding=NEW.binding
          AND s.verified_home<=i.home AND s.verified_root IS NOT NULL AND NOT s.complete
        ORDER BY s.verified_home DESC LIMIT 1
      ) w
      CROSS JOIN LATERAL search.public_filter_ack_window(w.state,i.home) win
      JOIN semantic.public_filter_home_enrollment e ON (e.partition_no,e.bootstrap)=(i.home,a.bootstrap)
        AND e.complete AND e.registration_partition=0 AND e.registration=a.registration AND e.read_definition=a.read_definition
        AND (e.owner_epoch,e.receipt,e.creation_position)=(win.epoch,win.receipt,win.base)
        AND e.creation_consumer='public_filter_'||replace(a.bootstrap::text,'-','')
      JOIN core.partition p ON p.partition_no=i.home AND p.epoch=e.owner_epoch AND p.write_state='active' AND p.position>=win.through_pos
      JOIN core.consumer_checkpoint ck ON (ck.partition_no,ck.consumer)=(i.home,e.creation_consumer)
        AND ck.position<=win.base AND (ck.epoch IS NULL OR ck.epoch=p.epoch)
      JOIN semantic.public_filter_privacy_head ph ON ph.partition_no=i.home AND ph.owner_epoch=p.epoch AND ph.position>=e.source_position
      JOIN access.account_discovery_population ac ON ac.partition_no=i.home
      JOIN search.public_filter_coverage_baseline b ON (b.partition_no,b.registration,b.bootstrap,b.source_home)=(0,a.registration,a.bootstrap,i.home)
        AND (b.source_epoch,b.receipt,b.creation_position,b.source_position,b.native_enqueue_revision)=
            (e.owner_epoch,e.receipt,e.creation_position,e.source_position,e.native_enqueue_revision)
        AND b.native_revision IS NOT DISTINCT FROM e.native_revision AND b.native_claim_revision IS NOT DISTINCT FROM e.native_claim_revision
      JOIN search.public_filter_coverage_home h ON (h.partition_no,h.registration,h.source_home)=(0,a.registration,i.home)
        AND h.source_epoch=e.owner_epoch AND h.baseline_bootstrap=e.bootstrap
        AND h.acknowledged_position<=b.source_position AND h.acknowledged_native_enqueue<=b.native_enqueue_revision
      WHERE e.partition_no>=NEW.first_home AND e.partition_no<NEW.first_home+NEW.width
        AND b.source_home>=NEW.first_home AND b.source_home<NEW.first_home+NEW.width
        AND h.source_home>=NEW.first_home AND h.source_home<NEW.first_home+NEW.width
        AND h.baseline_delta=(h.relevant_position>b.source_position OR h.native_enqueue_revision>b.native_enqueue_revision
        OR h.native_revision IS DISTINCT FROM b.native_revision OR h.native_claim_revision IS DISTINCT FROM b.native_claim_revision)
    ), ordered AS (
      SELECT m.*,lag(root) OVER (ORDER BY home) AS prior FROM members m
    )
    SELECT count(*),bool_and(prior IS NULL OR prior=predecessor),
      max(predecessor) FILTER (WHERE home=NEW.first_home),max(root) FILTER (WHERE home=NEW.first_home+NEW.width-1),
      sha256(convert_to(jsonb_agg(to_jsonb(ordered) ORDER BY home)::text,'UTF8'))
    INTO homes,chain_ok,NEW.predecessor,NEW.enrollment_root,NEW.digest FROM ordered;
    IF homes<>NEW.width OR chain_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'Original receiver home evidence unavailable' USING ERRCODE='40001';
    END IF;
  ELSE
    child_cut := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width/2,foreign_cut);
    SELECT * INTO STRICT l FROM search.public_filter_ack_range
      WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home,NEW.width/2,child_cut);
    child_cut := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home+NEW.width/2,NEW.width/2,foreign_cut);
    SELECT * INTO STRICT r FROM search.public_filter_ack_range
      WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home+NEW.width/2,NEW.width/2,child_cut);
    IF (l.registration,l.bootstrap,l.enrollment_root) IS DISTINCT FROM (a.registration,a.bootstrap,r.predecessor)
      OR (r.registration,r.bootstrap) IS DISTINCT FROM (a.registration,a.bootstrap)
      OR l.identity_digest<>a.identity_digest OR r.identity_digest<>a.identity_digest THEN
      RAISE EXCEPTION 'Discontinuous receiver range' USING ERRCODE='40001';
    END IF;
    NEW.left_child := l.revision;
    NEW.right_child := r.revision;
    NEW.predecessor := l.predecessor;
    NEW.enrollment_root := r.enrollment_root;
    NEW.digest := sha256(uuid_send(l.revision)||l.digest||uuid_send(r.revision)||r.digest);
  END IF;
  NEW.digest := sha256(convert_to(jsonb_build_array('subject-receiver-baseline/v1',a.job,a.registration,a.bootstrap,
    a.read_definition,a.release_digest,a.owner_epoch,a.physical_target,a.incarnation,a.observation,a.execution,
    a.identity_digest,a.generation,a.enrollment_root,NEW.binding,NEW.first_home,NEW.width,NEW.witness,NEW.digest)::text,'UTF8'));
  SELECT * INTO previous_node FROM search.public_filter_ack_range
    WHERE (partition_no,job,binding,first_home,width,witness)=(0,NEW.job,NEW.binding,NEW.first_home,NEW.width,NEW.witness);
  IF FOUND AND (previous_node.digest,previous_node.bootstrap,previous_node.registration,previous_node.left_child,previous_node.right_child) IS DISTINCT FROM
    (NEW.digest,NEW.bootstrap,NEW.registration,NEW.left_child,NEW.right_child) THEN
    RAISE EXCEPTION 'Conflicting receiver range replay' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_ack_range_compare BEFORE INSERT ON search.public_filter_ack_range
  FOR EACH ROW EXECUTE FUNCTION search.compare_public_filter_ack_range();

-- A funded turn prepares one missing subtree. A lost reply resolves its exact
-- revision on the next descent. A stale subtree is unreachable under the new witness.
CREATE FUNCTION search.prepare_public_filter_ack(job_id uuid, leaf_limit integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  chain text;
  available integer;
  witness_cut bytea;
  local_cut bytea;
  span integer := 4096;
  first integer := 0;
  left_id uuid;
  right_id uuid;
BEGIN
  IF leaf_limit NOT BETWEEN 1 AND 16 OR leaf_limit IS NULL THEN
    RAISE EXCEPTION 'Invalid receiver leaf allowance' USING ERRCODE='22023';
  END IF;
  SELECT * INTO a FROM search.public_filter_ack_authority WHERE job=job_id AND phase='reconciled' AND pass=1
    AND fence IS NULL AND NOT fenced_pass;
  IF NOT FOUND OR EXISTS (SELECT FROM search.public_filter_ack_manifest WHERE (partition_no,job)=(0,job_id)) THEN RETURN 0; END IF;
  SELECT s.verified_binding,s.verified_home+coalesce(search.public_filter_ack_field(
    search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),'count')::integer,1)
    INTO chain,available FROM semantic.public_filter_repair_step s
    WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_home IS NOT NULL
    ORDER BY s.verified_home DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  witness_cut := search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']);
  local_cut := search.public_filter_ack_range_witness(a.bootstrap,0,4096,witness_cut);
  IF local_cut IS NULL OR EXISTS (SELECT FROM search.public_filter_ack_range n WHERE
    (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,0,4096,local_cut)) THEN RETURN -2; END IF;
  LOOP
    IF first>=available THEN RETURN -1; END IF;
    IF span<=leaf_limit AND first+span<=available THEN EXIT; END IF;
    local_cut := search.public_filter_ack_range_witness(a.bootstrap,first,span/2,witness_cut);
    SELECT revision INTO left_id FROM search.public_filter_ack_range n WHERE
      (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first,span/2,local_cut);
    IF left_id IS NOT NULL THEN
      local_cut := search.public_filter_ack_range_witness(a.bootstrap,first+span/2,span/2,witness_cut);
      SELECT revision INTO right_id FROM search.public_filter_ack_range n WHERE
        (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first+span/2,span/2,local_cut);
      IF right_id IS NOT NULL THEN EXIT; END IF;
      first := first+span/2;
    END IF;
    span := span/2;
    left_id := NULL;
    right_id := NULL;
  END LOOP;
  INSERT INTO search.public_filter_ack_range(partition_no,job,binding,first_home,width,left_child,right_child)
    VALUES (0,job_id,chain,first,span,left_id,right_id) ON CONFLICT DO NOTHING;
  RETURN CASE WHEN left_id IS NULL THEN span ELSE 0 END + 1;
END $$;

-- The settlement verifier calls this insertion only in its existing fenced transaction,
-- after validating the page/effect chain and native engine/writer winners.
CREATE FUNCTION search.bind_public_filter_ack_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  t semantic.public_filter_repair_step%ROWTYPE;
  root search.public_filter_ack_range%ROWTYPE;
  state jsonb;
  proof jsonb;
  last_page jsonb;
  pages integer;
  current_cut bytea;
BEGIN
  -- Same short lock order as explicit ACK and receiver fanout.
  PERFORM FROM core.partition WHERE partition_no=0 AND write_state='active' FOR SHARE;
  PERFORM FROM search.public_filter_target target JOIN search.generation_publication j
    ON (target.partition_no,target.physical_target,target.incarnation)=(j.partition_no,j.physical_target,j.native_incarnation)
    WHERE (j.partition_no,j.job)=(0,NEW.job) FOR SHARE OF target,j;
  PERFORM FROM search.public_filter_registration r JOIN search.public_filter_ack_authority v
    ON (r.partition_no,r.id)=(v.partition_no,v.registration) WHERE v.job=NEW.job FOR UPDATE OF r;
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority
    WHERE job=NEW.job AND phase='reconciled' AND pass=1 AND NOT fenced_pass AND fence IS NULL FOR SHARE;
  SELECT * INTO STRICT t FROM semantic.public_filter_repair_step s
    WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.complete
      AND s.verified_binding IS NOT NULL AND s.verified_root IS NOT NULL AND s.verified_next IS NULL AND s.ack_after=0 FOR SHARE;
  current_cut := search.public_filter_ack_range_witness(a.bootstrap,0,4096,
    search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']));
  SELECT * INTO STRICT root FROM search.public_filter_ack_range
    WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,t.verified_binding,0,4096,current_cut)
      AND registration=a.registration AND bootstrap=a.bootstrap AND enrollment_root=a.enrollment_root AND identity_digest=a.identity_digest;
  state := a.repair_settlement::jsonb->1;
  pages := search.public_filter_ack_field(state,'pages')::integer;
  SELECT v.progress::jsonb->1,v.evidence_revision INTO STRICT proof,NEW.evidence_revision FROM search.public_filter_repair_verification v
    WHERE (v.partition_no,v.observation,v.execution)=(0,a.observation,a.execution) FOR SHARE;
  SELECT CASE WHEN page.intent::jsonb->>0='references' THEN page.intent::jsonb#>'{1,1,1}' ELSE page.intent::jsonb->1 END
    INTO STRICT last_page FROM search.public_filter_repair_page page
    WHERE (page.partition_no,page.observation,page.execution,page.ordinal)=(0,a.observation,a.execution,pages-1) FOR SHARE;
  IF (search.public_filter_ack_field(state,'closed')='true' AND search.public_filter_ack_field(state,'frontier')='null'
    AND search.public_filter_ack_field(state,'bootstrap')#>>'{}'='0:'||a.bootstrap::text
    AND search.public_filter_ack_field(state,'execution')#>>'{}'=a.execution
    AND search.public_filter_ack_field(search.public_filter_ack_field(state,'fence'),'transaction')#>>'{}'=pg_current_xact_id()::text
    AND search.public_filter_ack_field(search.public_filter_ack_field(state,'fence'),'incarnation')#>>'{}'=a.incarnation
    AND search.public_filter_ack_field(search.public_filter_ack_field(state,'fence'),'sourceEpoch')::integer=a.owner_epoch
    AND search.public_filter_ack_field(proof,'after')::integer=pages-1 AND search.public_filter_ack_field(proof,'linked')::integer=pages-1
    AND search.public_filter_ack_field(search.public_filter_ack_field(proof,'winners'),'done')='true'
    AND search.public_filter_ack_field(last_page,'sourceStep')#>>'{}'=t.step::text
    AND search.public_filter_ack_field(last_page,'complete')='true') IS NOT TRUE THEN
    RAISE EXCEPTION 'Receiver manifest requires the original fenced terminal settlement' USING ERRCODE='40001';
  END IF;
  NEW.partition_no := 0; NEW.registration := a.registration; NEW.bootstrap := a.bootstrap;
  NEW.version := 1; NEW.root_revision := root.revision; NEW.root_digest := root.digest;
  NEW.generation := a.generation; NEW.enrollment_root := a.enrollment_root; NEW.owner_epoch := a.owner_epoch;
  NEW.physical_target := a.physical_target; NEW.incarnation := a.incarnation;
  NEW.observation := a.observation; NEW.execution := a.execution; NEW.terminal := t.step;
  NEW.binding := t.verified_binding; NEW.ordinal := t.verified_ordinal; NEW.terminal_root := t.verified_root;
  NEW.settlement := search.public_filter_ack_field(state,'id')#>>'{}';
  NEW.settlement_digest := search.public_filter_ack_settlement_digest(state);
  NEW.identity_digest := a.identity_digest;
  NEW.continuity := (SELECT sha256(uuid_send(clock.incarnation)||int8send(clock.continuity)||
        search.public_filter_ack_witness(ARRAY['','@ack-retention'])) FROM search.public_filter_ack_home_clock clock
        WHERE (clock.bootstrap,clock.first_home,clock.width)=(a.bootstrap,0,4096) FOR SHARE OF clock);
  NEW.committed_by := pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_ack_manifest_bind BEFORE INSERT ON search.public_filter_ack_manifest
  FOR EACH ROW EXECUTE FUNCTION search.bind_public_filter_ack_manifest();


-- Historical readback deliberately does not require unchanged privacy position or
-- current receiver generation. A later obligation has its own pending/delta receipts.
CREATE FUNCTION semantic.public_filter_committed_ack(
  original_bootstrap uuid, original_execution text, original_step uuid, original_binding text
) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT FROM search.public_filter_ack_manifest m
    JOIN search.public_filter_ack_authority a ON (a.partition_no,a.job,a.registration,a.bootstrap,a.observation,a.execution,
      a.owner_epoch,a.physical_target,a.incarnation,a.generation,a.enrollment_root)=
      (m.partition_no,m.job,m.registration,m.bootstrap,m.observation,m.execution,
      m.owner_epoch,m.physical_target,m.incarnation,m.generation,m.enrollment_root)
    JOIN search.public_filter_repair_verification v ON (v.partition_no,v.observation,v.execution,v.evidence_revision)=
      (m.partition_no,m.observation,m.execution,m.evidence_revision)
    JOIN search.public_filter_ack_range r ON (r.revision,r.digest,r.partition_no,r.job,r.registration,r.bootstrap,r.binding,
      r.first_home,r.width,r.enrollment_root)=(m.root_revision,m.root_digest,m.partition_no,m.job,m.registration,m.bootstrap,
      m.binding,0,4096,m.enrollment_root)
    JOIN semantic.public_filter_repair_step t ON (t.partition_no,t.bootstrap,t.execution,t.step,t.verified_binding,
      t.verified_root,t.verified_ordinal)=(m.partition_no,m.bootstrap,m.execution,m.terminal,m.binding,m.terminal_root,m.ordinal)
    WHERE (m.partition_no,m.job,m.bootstrap,m.execution,m.terminal,m.binding)=(0,original_execution::uuid,original_bootstrap,
      original_execution,original_step,original_binding) AND a.identity_digest=m.identity_digest AND r.identity_digest=m.identity_digest AND m.version=1 AND t.complete AND t.verified_next IS NULL
      AND search.public_filter_ack_settlement_digest(a.repair_settlement::jsonb->1)=m.settlement_digest
      AND search.public_filter_ack_field(a.repair_settlement::jsonb->1,'id')#>>'{}'=m.settlement
      AND search.public_filter_ack_field(a.repair_settlement::jsonb->1,'closed')='true'
      AND search.public_filter_ack_field(a.repair_settlement::jsonb->1,'frontier')='null'
      AND search.public_filter_ack_field(search.public_filter_ack_field(a.repair_settlement::jsonb->1,'fence'),'incarnation')#>>'{}'=a.incarnation
      AND m.committed_by<>pg_current_xact_id()
      AND m.continuity=(SELECT sha256(uuid_send(clock.incarnation)||int8send(clock.continuity)||
        search.public_filter_ack_witness(ARRAY['','@ack-retention'])) FROM search.public_filter_ack_home_clock clock
        WHERE (clock.bootstrap,clock.first_home,clock.width)=(a.bootstrap,0,4096) FOR SHARE OF clock)
    FOR SHARE OF a,m,r,v
  )
$$;
CREATE OR REPLACE FUNCTION semantic.retain_public_filter_repair_ack() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ack_after IS DISTINCT FROM OLD.ack_after AND EXISTS (
    SELECT FROM search.public_filter_coverage_preparation c WHERE c.bootstrap=OLD.bootstrap AND c.ack_protocol=1
  ) THEN
    IF OLD.ack_after<>0 OR NEW.ack_after<>4096 OR NEW.verified_home IS DISTINCT FROM OLD.verified_home OR
      NOT semantic.public_filter_committed_ack(OLD.bootstrap,OLD.execution,OLD.step,OLD.verified_binding) THEN
      RAISE EXCEPTION 'Source ACK requires the committed original receiver manifest'
        USING ERRCODE='23514', CONSTRAINT='public_filter_repair_ack_manifest';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.verified_home IS NOT NULL AND NEW.verified_home IS DISTINCT FROM OLD.verified_home)
    OR NEW.ack_after<OLD.ack_after OR NEW.ack_after>OLD.ack_after+24
    OR (NEW.ack_after<>OLD.ack_after AND
      (NOT OLD.complete OR OLD.verified_root IS NULL OR OLD.verified_next IS NOT NULL)) THEN
    RAISE EXCEPTION 'Original repair window and contiguous ACK progress cannot be replaced'
      USING ERRCODE='23514';
  END IF;
  IF NEW.ack_after>OLD.ack_after AND NOT EXISTS (
    SELECT 1
    FROM semantic.public_filter_bootstrap cut
    JOIN core.partition p ON p.partition_no=cut.partition_no
    JOIN semantic.public_filter_home_enrollment e ON e.bootstrap=cut.bootstrap
    JOIN search.public_filter_coverage_home h
      ON (h.partition_no,h.registration,h.source_home)=(e.registration_partition,e.registration,e.partition_no)
    JOIN search.public_filter_coverage_baseline b
      ON (b.partition_no,b.registration,b.bootstrap,b.source_home)=
         (e.registration_partition,e.registration,e.bootstrap,e.partition_no)
    WHERE (cut.partition_no,cut.bootstrap)=(OLD.partition_no,OLD.bootstrap)
      AND cut.owner_epoch=p.epoch AND p.write_state='active' AND cut.state='adopted'
      AND e.partition_no>=OLD.ack_after AND e.partition_no<NEW.ack_after
      AND e.complete AND e.read_definition=cut.read_definition AND b.receipt=e.receipt
      AND h.source_epoch=e.owner_epoch AND h.baseline_bootstrap=e.bootstrap
      AND h.acknowledged_baseline=e.bootstrap AND h.acknowledged_position>=b.source_position
      AND h.acknowledged_observation=cut.queried AND h.acknowledged_execution=OLD.execution
      AND h.acknowledged_settlement IS NOT NULL
      AND h.acknowledged_native_enqueue>=b.native_enqueue_revision
      AND h.acknowledged_native_revision IS NOT DISTINCT FROM b.native_revision
      AND h.acknowledged_native_claim_revision IS NOT DISTINCT FROM b.native_claim_revision
    HAVING count(*)=NEW.ack_after-OLD.ack_after AND count(DISTINCT h.acknowledged_settlement)=1
  ) THEN
    RAISE EXCEPTION 'Contiguous Source ACK progress requires every original receiver receipt'
      USING ERRCODE='23514', CONSTRAINT='public_filter_repair_ack_receiver_prefix';
  END IF;
  RETURN NEW;
END $$;


-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'A retained receiver manifest requires forward migration'; END $$;
