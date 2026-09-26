-- Private workflow state for large Structure replacement, import, refresh, capture
-- and restore. The graph owns the Structure, its generations, revisions, receipts
-- and outbox. A stage job is never a revision: only its guarded graph activation
-- is, and that graph receipt settles the job. Staged pages are immutable objects;
-- rows here pin them and record the lease-fenced, contiguous checkpoint.
CREATE SCHEMA IF NOT EXISTS structure;

CREATE TABLE structure.stage_job (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  authority_scope text NOT NULL CHECK (length(authority_scope) BETWEEN 1 AND 300),
  structure text NOT NULL CHECK (structure ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  generation text NOT NULL UNIQUE CHECK (generation ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  kind text NOT NULL CHECK (kind IN ('replace', 'import', 'refresh', 'capture', 'restore')),
  base_head text NOT NULL CHECK (base_head ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 500),
  source_revision text CHECK (source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 500),
  mapping_policy text CHECK (mapping_policy IS NULL OR mapping_policy IN ('source-key', 'explicit')),
  restored_from text CHECK (restored_from IS NULL
    OR restored_from ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  status text NOT NULL DEFAULT 'staging'
    CHECK (status IN ('staging', 'sealed', 'activated', 'cancelled', 'failed')),
  lease_holder uuid,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  lease_expires_at timestamptz,
  deadline_at timestamptz NOT NULL,
  source_cursor text CHECK (source_cursor IS NULL OR octet_length(source_cursor) BETWEEN 1 AND 1024),
  staged_pages integer NOT NULL DEFAULT 0 CHECK (staged_pages BETWEEN 0 AND 16384),
  staged_records bigint NOT NULL DEFAULT 0 CHECK (staged_records BETWEEN 0 AND 1048576),
  staged_bytes bigint NOT NULL DEFAULT 0 CHECK (staged_bytes BETWEEN 0 AND 1073741824),
  graph_started boolean NOT NULL DEFAULT false,
  projection_batches integer NOT NULL DEFAULT 0 CHECK (projection_batches BETWEEN 0 AND 16384),
  root_manifest text CHECK (root_manifest IS NULL OR root_manifest ~ '^[0-9a-f]{64}$'),
  placement_count integer CHECK (placement_count IS NULL OR placement_count BETWEEN 0 AND 1048576),
  coverage text CHECK (coverage IS NULL OR coverage IN ('complete', 'partial')),
  graph_receipt text CHECK (graph_receipt IS NULL OR length(graph_receipt) BETWEEN 1 AND 300),
  graph_data_epoch uuid,
  graph_sequence bigint CHECK (graph_sequence IS NULL OR graph_sequence > 0),
  revision text CHECK (revision IS NULL OR revision ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  failure_reason text CHECK (failure_reason IS NULL
    OR (length(failure_reason) BETWEEN 1 AND 500 AND failure_reason !~ '[[:cntrl:]]')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (principal_id, idempotency_key),
  CHECK (deadline_at > created_at),
  CHECK ((kind IN ('import', 'refresh', 'capture'))
    = (source_ref IS NOT NULL AND source_revision IS NOT NULL)),
  CHECK ((kind IN ('import', 'refresh')) = (mapping_policy IS NOT NULL)),
  CHECK ((kind = 'restore') = (restored_from IS NOT NULL)),
  CHECK (coverage IS NULL OR kind = 'capture'),
  CHECK (kind <> 'capture' OR status NOT IN ('sealed', 'activated') OR coverage IS NOT NULL),
  CHECK ((lease_holder IS NULL) = (lease_expires_at IS NULL)),
  CHECK (status IN ('staging', 'sealed') OR lease_holder IS NULL),
  CHECK (projection_batches = 0 OR graph_started),
  CHECK ((graph_receipt IS NULL) = (graph_data_epoch IS NULL)
    AND (graph_receipt IS NULL) = (graph_sequence IS NULL)),
  CHECK ((status IN ('staging')
      AND root_manifest IS NULL AND placement_count IS NULL AND graph_receipt IS NULL
      AND revision IS NULL AND failure_reason IS NULL AND settled_at IS NULL)
    OR (status = 'sealed'
      AND root_manifest IS NOT NULL AND placement_count IS NOT NULL AND graph_receipt IS NULL
      AND revision IS NULL AND failure_reason IS NULL AND settled_at IS NULL)
    OR (status = 'activated' AND graph_started
      AND root_manifest IS NOT NULL AND placement_count IS NOT NULL AND graph_receipt IS NOT NULL
      AND revision IS NOT NULL AND failure_reason IS NULL AND settled_at IS NOT NULL)
    OR (status = 'cancelled' AND graph_started = (graph_receipt IS NOT NULL)
      AND revision IS NULL AND failure_reason IS NULL AND settled_at IS NOT NULL)
    OR (status = 'failed' AND graph_started = (graph_receipt IS NOT NULL)
      AND revision IS NULL AND failure_reason IS NOT NULL AND settled_at IS NOT NULL))
);
-- One open stage per Structure bounds staged bytes; concurrent edits still race on the head.
CREATE UNIQUE INDEX stage_job_open_structure_idx ON structure.stage_job (structure)
  WHERE status IN ('staging', 'sealed');
CREATE INDEX stage_job_lease_idx ON structure.stage_job (lease_expires_at, id)
  WHERE status IN ('staging', 'sealed');
CREATE INDEX stage_job_deadline_idx ON structure.stage_job (deadline_at, id)
  WHERE status IN ('staging', 'sealed');
CREATE INDEX stage_job_structure_idx ON structure.stage_job (structure, created_at, id);

CREATE TABLE structure.stage_page (
  job_id uuid NOT NULL REFERENCES structure.stage_job(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 16383),
  page_digest text NOT NULL CHECK (page_digest ~ '^[0-9a-f]{64}$'),
  tree text NOT NULL CHECK (tree IN ('record', 'order')),
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 5),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 1 AND 256),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 262144),
  lease_fence bigint NOT NULL CHECK (lease_fence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, ordinal)
);
CREATE INDEX stage_page_digest_idx ON structure.stage_page (page_digest);

CREATE FUNCTION structure.stage_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Structure stage job cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('activated', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'settled Structure stage job is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.principal_id, OLD.idempotency_key, OLD.request_digest, OLD.authority_scope,
      OLD.structure, OLD.generation, OLD.kind, OLD.base_head, OLD.source_ref, OLD.source_revision,
      OLD.mapping_policy, OLD.restored_from, OLD.deadline_at, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.principal_id, NEW.idempotency_key, NEW.request_digest, NEW.authority_scope,
      NEW.structure, NEW.generation, NEW.kind, NEW.base_head, NEW.source_ref, NEW.source_revision,
      NEW.mapping_policy, NEW.restored_from, NEW.deadline_at, NEW.created_at) THEN
    RAISE EXCEPTION 'immutable Structure stage identity' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'sealed' AND NEW.status = 'staging' THEN
    RAISE EXCEPTION 'sealed Structure stage cannot reopen' USING ERRCODE = '23514';
  END IF;
  IF NEW.lease_fence < OLD.lease_fence OR (NEW.lease_holder IS NOT NULL
      AND NEW.lease_holder IS DISTINCT FROM OLD.lease_holder AND NEW.lease_fence <= OLD.lease_fence) THEN
    RAISE EXCEPTION 'Structure stage lease fence must advance on each claim' USING ERRCODE = '23514';
  END IF;
  IF (OLD.graph_started AND NOT NEW.graph_started) OR NEW.projection_batches < OLD.projection_batches THEN
    RAISE EXCEPTION 'Structure stage graph progress cannot regress' USING ERRCODE = '23514';
  END IF;
  -- Counters move only with the contiguous page insert below (nested trigger depth).
  IF pg_trigger_depth() = 1 AND (OLD.staged_pages, OLD.staged_records, OLD.staged_bytes)
     IS DISTINCT FROM (NEW.staged_pages, NEW.staged_records, NEW.staged_bytes) THEN
    RAISE EXCEPTION 'Structure stage counters advance only with staged pages' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'staging' AND (OLD.source_cursor IS DISTINCT FROM NEW.source_cursor
      OR OLD.root_manifest IS DISTINCT FROM NEW.root_manifest
      OR OLD.placement_count IS DISTINCT FROM NEW.placement_count
      OR OLD.coverage IS DISTINCT FROM NEW.coverage) THEN
    RAISE EXCEPTION 'sealed Structure stage manifest is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stage_job_monotone BEFORE UPDATE OR DELETE ON structure.stage_job
  FOR EACH ROW EXECUTE FUNCTION structure.stage_job_guard();

-- A page is admitted only under the job's current unexpired lease and exactly at
-- the checkpoint, so a stale worker cannot interleave or leave a gap.
CREATE FUNCTION structure.stage_page_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job structure.stage_job%ROWTYPE;
BEGIN
  SELECT * INTO job FROM structure.stage_job WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND OR job.status <> 'staging' THEN
    RAISE EXCEPTION 'Structure stage is not accepting pages'
      USING ERRCODE = '23514', CONSTRAINT = 'stage_page_open_job';
  END IF;
  IF job.lease_holder IS NULL OR job.lease_fence <> NEW.lease_fence
     OR job.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Structure stage lease is stale'
      USING ERRCODE = '23514', CONSTRAINT = 'stage_page_current_lease';
  END IF;
  IF NEW.ordinal <> job.staged_pages THEN
    RAISE EXCEPTION 'Structure stage page is not at the checkpoint'
      USING ERRCODE = '23514', CONSTRAINT = 'stage_page_contiguous';
  END IF;
  UPDATE structure.stage_job SET staged_pages = staged_pages + 1,
    staged_bytes = staged_bytes + NEW.byte_length,
    staged_records = staged_records
      + CASE WHEN NEW.tree = 'record' AND NEW.level = 0 THEN NEW.entry_count ELSE 0 END
  WHERE id = NEW.job_id;
  RETURN NEW;
END $$;
CREATE TRIGGER stage_page_checkpoint BEFORE INSERT ON structure.stage_page
  FOR EACH ROW EXECUTE FUNCTION structure.stage_page_admit();

-- Pins are released only after the job settles; the activated manifest then
-- retains its pages through graph reachability.
CREATE FUNCTION structure.stage_page_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM structure.stage_job
      WHERE id = OLD.job_id AND status IN ('staging', 'sealed')) THEN
    RAISE EXCEPTION 'staged Structure page is pinned' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER stage_page_pinned BEFORE UPDATE OR DELETE ON structure.stage_page
  FOR EACH ROW EXECUTE FUNCTION structure.stage_page_guard();
