-- An installation is one environment root's materialized topology. Main
-- records plans, inventory and the recovery journal; admitted runners perform
-- effects and report them. head_epoch is the environment generation CAS.
CREATE TABLE pkg.installation (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  target_key text NOT NULL CHECK (target_key ~ '^[A-Za-z0-9:_./-]+$' AND octet_length(target_key) <= 256),
  environment jsonb NOT NULL
    CHECK (jsonb_typeof(environment) = 'object' AND octet_length(environment::text) <= 16384),
  state text NOT NULL DEFAULT 'present' CHECK (state IN ('present', 'removed')),
  active_generation_id uuid,
  head_epoch bigint NOT NULL DEFAULT 0 CHECK (head_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (id, principal_id),
  UNIQUE (id, target_key)
);
CREATE INDEX installation_principal_idx ON pkg.installation (principal_id, id);
CREATE INDEX installation_target_idx ON pkg.installation (target_key, id);

-- Generations follow planned -> fetching -> verified -> staged -> activating
-- -> active -> superseded; a removal plans no fetch. Rejection happens before
-- activation and names its reason. One in-flight and one active generation
-- per installation keep concurrent plans from mixing.
CREATE TABLE pkg.installation_generation (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('install', 'update', 'rollback', 'remove')),
  lock_id uuid,
  expected_prior_generation_id uuid,
  rollback_of_generation_id uuid,
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'fetching', 'verified',
    'staged', 'activating', 'active', 'superseded', 'rejected', 'failed')),
  terminal_reason text CHECK (terminal_reason IN ('path-traversal', 'ownership-collision',
    'unapproved-hook', 'artifact-unverified', 'artifact-revoked', 'authority-revoked',
    'stale-generation', 'cancelled', 'step-failed')),
  activation_admission_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (installation_id, number),
  UNIQUE (id, installation_id),
  UNIQUE (id, lock_id),
  FOREIGN KEY (installation_id, principal_id) REFERENCES pkg.installation(id, principal_id),
  FOREIGN KEY (lock_id, principal_id) REFERENCES pkg.lock(id, principal_id),
  FOREIGN KEY (expected_prior_generation_id, installation_id)
    REFERENCES pkg.installation_generation(id, installation_id),
  FOREIGN KEY (rollback_of_generation_id, installation_id)
    REFERENCES pkg.installation_generation(id, installation_id),
  CHECK ((operation = 'remove') = (lock_id IS NULL)),
  CHECK ((operation = 'rollback') = (rollback_of_generation_id IS NOT NULL)),
  CHECK ((operation = 'install') = (expected_prior_generation_id IS NULL)),
  CHECK ((state IN ('rejected', 'failed')) = (terminal_reason IS NOT NULL)),
  CONSTRAINT installation_generation_admitted
    CHECK (state NOT IN ('activating', 'active', 'superseded') OR activation_admission_id IS NOT NULL)
);
CREATE UNIQUE INDEX installation_generation_inflight ON pkg.installation_generation (installation_id)
  WHERE state IN ('planned', 'fetching', 'verified', 'staged', 'activating');
CREATE UNIQUE INDEX installation_generation_active ON pkg.installation_generation (installation_id)
  WHERE state = 'active';
CREATE INDEX installation_generation_lock_idx ON pkg.installation_generation (lock_id)
  WHERE lock_id IS NOT NULL;
ALTER TABLE pkg.installation ADD CONSTRAINT installation_active_generation_fk
  FOREIGN KEY (active_generation_id, id) REFERENCES pkg.installation_generation(id, installation_id);

-- Plan steps are immutable. Code-executing steps need an exact approval
-- reference and executor; downloading a package grants no hook permission.
CREATE TABLE pkg.installation_step (
  generation_id uuid NOT NULL REFERENCES pkg.installation_generation(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 1023),
  action text NOT NULL CHECK (action IN ('fetch', 'verify', 'unpack', 'build', 'configure',
    'register', 'switch', 'remove')),
  step_key text NOT NULL CHECK (step_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  lock_id uuid,
  artifact_ordinal integer,
  executes_code boolean NOT NULL,
  idempotent boolean NOT NULL,
  hook_approval_id uuid,
  executor_profile text CHECK (executor_profile ~ '^[a-z0-9][a-z0-9.-]{0,99}$'),
  capabilities jsonb NOT NULL
    CHECK (jsonb_typeof(capabilities) = 'array' AND octet_length(capabilities::text) <= 4096),
  compensation text NOT NULL CHECK (compensation IN ('none', 'discard-staging',
    'restore-prior-generation', 'inspect-effect')),
  PRIMARY KEY (generation_id, ordinal),
  UNIQUE (generation_id, step_key),
  FOREIGN KEY (generation_id, lock_id) REFERENCES pkg.installation_generation(id, lock_id),
  FOREIGN KEY (lock_id, artifact_ordinal) REFERENCES pkg.lock_artifact(lock_id, ordinal),
  CHECK ((lock_id IS NULL) = (artifact_ordinal IS NULL)),
  CHECK (action NOT IN ('fetch', 'verify', 'unpack') OR lock_id IS NOT NULL),
  CHECK (NOT executes_code OR action IN ('build', 'configure', 'register')),
  CHECK ((hook_approval_id IS NULL) = (executor_profile IS NULL)),
  CHECK (hook_approval_id IS NULL OR executes_code),
  CHECK (NOT executes_code OR compensation = 'inspect-effect')
);
CREATE TRIGGER pkg_installation_step_immutable BEFORE UPDATE OR DELETE ON pkg.installation_step
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_installation_step_open BEFORE INSERT ON pkg.installation_step
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('pkg_generation', 'generation_id');

-- Verified bytes each generation uses. These rows pin retention; rollback
-- reuses them only while the artifact remains verified and unrevoked.
CREATE TABLE pkg.installation_artifact (
  generation_id uuid NOT NULL,
  lock_id uuid NOT NULL,
  artifact_ordinal integer NOT NULL,
  artifact_id uuid NOT NULL,
  artifact_sha256 text NOT NULL,
  PRIMARY KEY (generation_id, artifact_ordinal),
  FOREIGN KEY (generation_id, lock_id) REFERENCES pkg.installation_generation(id, lock_id),
  FOREIGN KEY (lock_id, artifact_ordinal) REFERENCES pkg.lock_artifact(lock_id, ordinal),
  FOREIGN KEY (artifact_id, artifact_sha256) REFERENCES pkg.artifact(id, sha256)
);
CREATE INDEX installation_artifact_artifact_idx ON pkg.installation_artifact (artifact_id);
CREATE INDEX installation_artifact_sha256_idx ON pkg.installation_artifact (artifact_sha256);
CREATE TRIGGER pkg_installation_artifact_immutable BEFORE UPDATE OR DELETE ON pkg.installation_artifact
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();

-- True when an artifact row may feed an activation now.
CREATE FUNCTION pkg.artifact_eligible(artifact uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pkg.artifact a WHERE a.id = artifact AND a.state = 'verified'
    AND NOT EXISTS (SELECT 1 FROM pkg.artifact_revocation v WHERE v.sha256 = a.sha256))
$$;

CREATE FUNCTION pkg.check_installation_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM pkg.artifact WHERE id = NEW.artifact_id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM pkg.installation_generation g WHERE g.id = NEW.generation_id
      AND g.state IN ('fetching', 'verified'))
    OR NOT pkg.artifact_eligible(NEW.artifact_id) OR EXISTS (
    SELECT 1 FROM pkg.lock_artifact l WHERE l.lock_id = NEW.lock_id
      AND l.ordinal = NEW.artifact_ordinal
      AND (l.integrity_basis = 'unverifiable'
        OR (l.digest_algorithm = 'sha256' AND l.digest_value <> NEW.artifact_sha256))) THEN
    RAISE EXCEPTION 'installation artifact is not verified for its lock' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_artifact_verified';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pkg_installation_artifact_verified BEFORE INSERT ON pkg.installation_artifact
  FOR EACH ROW EXECUTE FUNCTION pkg.check_installation_artifact();

-- Owned inventory per generation. Paths and symlink targets are confined to
-- the environment root. collision_key is the adapter's platform folding of
-- the path (for example NFC plus case folding on a case-insensitive root).
CREATE TABLE pkg.installation_path (
  generation_id uuid NOT NULL,
  path text NOT NULL CHECK (pkg.confined_path(path)),
  collision_key text NOT NULL CHECK (pkg.confined_path(collision_key)),
  kind text NOT NULL CHECK (kind IN ('file', 'directory', 'symlink')),
  ownership text NOT NULL CHECK (ownership IN ('installation', 'user-data')),
  step_ordinal smallint NOT NULL,
  content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  symlink_target text CHECK (pkg.confined_path(symlink_target)),
  PRIMARY KEY (generation_id, path),
  UNIQUE (generation_id, collision_key),
  FOREIGN KEY (generation_id, step_ordinal) REFERENCES pkg.installation_step(generation_id, ordinal),
  CHECK ((kind = 'symlink') = (symlink_target IS NOT NULL)),
  CHECK (kind = 'file' OR content_sha256 IS NULL)
);
CREATE TRIGGER pkg_installation_path_immutable BEFORE UPDATE OR DELETE ON pkg.installation_path
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_installation_path_open BEFORE INSERT ON pkg.installation_path
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('pkg_generation', 'generation_id');

-- Current exclusive ownership within one environment root. Staging claims
-- every owned path first; a claim held by another installation is an
-- ownership collision. Removal releases installation-owned claims only;
-- user-data claims survive removal and need a separate explicit release.
CREATE TABLE pkg.installation_path_claim (
  target_key text NOT NULL,
  collision_key text NOT NULL,
  installation_id uuid NOT NULL,
  path text NOT NULL CHECK (pkg.confined_path(path)),
  ownership text NOT NULL CHECK (ownership IN ('installation', 'user-data')),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (target_key, collision_key),
  FOREIGN KEY (installation_id, target_key) REFERENCES pkg.installation(id, target_key)
);
CREATE INDEX installation_path_claim_installation_idx
  ON pkg.installation_path_claim (installation_id, collision_key);

CREATE FUNCTION pkg.guard_installation_path_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR OLD.ownership = 'user-data' THEN
    RAISE EXCEPTION 'installation path claims are insert/release only; user data is preserved'
      USING ERRCODE = '23514', CONSTRAINT = 'installation_path_claim_release';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER pkg_installation_path_claim_guard BEFORE UPDATE OR DELETE ON pkg.installation_path_claim
  FOR EACH ROW EXECUTE FUNCTION pkg.guard_installation_path_claim();

-- Append-only recovery journal. Sequences are contiguous per generation.
-- A step outcome needs a prior intent, and a non-idempotent step with an
-- unknown or partial effect is not retried until inspected or compensated.
CREATE TABLE pkg.installation_journal (
  generation_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  step_ordinal smallint NOT NULL,
  event text NOT NULL CHECK (event IN ('intent', 'completed', 'failed', 'compensated',
    'reconciled', 'cancelled')),
  effect text NOT NULL CHECK (effect IN ('none', 'partial', 'complete', 'unknown')),
  evidence jsonb NOT NULL
    CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (generation_id, sequence),
  FOREIGN KEY (generation_id, step_ordinal) REFERENCES pkg.installation_step(generation_id, ordinal),
  CHECK (event <> 'intent' OR effect = 'none'),
  CHECK (event <> 'completed' OR effect = 'complete'),
  CHECK (event <> 'compensated' OR effect = 'none')
);
CREATE INDEX installation_journal_step_idx
  ON pkg.installation_journal (generation_id, step_ordinal, sequence DESC);
CREATE TRIGGER pkg_installation_journal_immutable BEFORE UPDATE OR DELETE ON pkg.installation_journal
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();

CREATE FUNCTION pkg.check_installation_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  generation_state text;
  next_sequence integer;
  step_idempotent boolean;
  prior_intent boolean;
  last_event text;
  last_effect text;
BEGIN
  SELECT state INTO generation_state FROM pkg.installation_generation
    WHERE id = NEW.generation_id FOR UPDATE;
  SELECT COALESCE(max(sequence), 0) + 1 INTO next_sequence
    FROM pkg.installation_journal WHERE generation_id = NEW.generation_id;
  IF NEW.sequence <> next_sequence THEN
    RAISE EXCEPTION 'installation journal sequence is not contiguous' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_journal_sequence';
  END IF;
  SELECT idempotent INTO step_idempotent FROM pkg.installation_step
    WHERE generation_id = NEW.generation_id AND ordinal = NEW.step_ordinal;
  SELECT true, j.event, j.effect INTO prior_intent, last_event, last_effect
    FROM pkg.installation_journal j
    WHERE j.generation_id = NEW.generation_id AND j.step_ordinal = NEW.step_ordinal
    ORDER BY j.sequence DESC LIMIT 1;
  IF NEW.event = 'intent' THEN
    IF generation_state NOT IN ('fetching', 'verified', 'staged', 'activating') THEN
      RAISE EXCEPTION 'installation generation admits no step effect' USING ERRCODE = '23514',
        CONSTRAINT = 'installation_journal_state';
    END IF;
    IF prior_intent AND NOT step_idempotent AND NOT (last_event = 'compensated'
      OR (last_event IN ('failed', 'reconciled', 'cancelled') AND last_effect = 'none')) THEN
      RAISE EXCEPTION 'non-idempotent step outcome needs reconciliation' USING ERRCODE = '23514',
        CONSTRAINT = 'installation_journal_retry';
    END IF;
  ELSIF prior_intent IS NULL THEN
    RAISE EXCEPTION 'installation step outcome has no intent' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_journal_intent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pkg_installation_journal_order BEFORE INSERT ON pkg.installation_journal
  FOR EACH ROW EXECUTE FUNCTION pkg.check_installation_journal();

-- Rollback reuses the exact lock of the generation it restores.
CREATE FUNCTION pkg.check_installation_generation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'planned' OR NEW.activation_admission_id IS NOT NULL
    OR (NEW.operation = 'rollback' AND NOT EXISTS (
      SELECT 1 FROM pkg.installation_generation g
      WHERE g.id = NEW.rollback_of_generation_id AND g.lock_id = NEW.lock_id
        AND g.state IN ('active', 'superseded'))) THEN
    RAISE EXCEPTION 'installation generation plan is invalid' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_generation_plan';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pkg_installation_generation_plan BEFORE INSERT ON pkg.installation_generation
  FOR EACH ROW EXECUTE FUNCTION pkg.check_installation_generation_insert();
CREATE TRIGGER pkg_installation_generation_open AFTER INSERT ON pkg.installation_generation
  FOR EACH ROW EXECUTE FUNCTION pkg.open_aggregate('pkg_generation', 'id');

-- Forward-only transitions. Leaving planned requires every code-executing
-- step to be approved. Activation requires the expected prior generation to
-- still be current and every locked artifact to be verified, retained and
-- unrevoked now. Becoming active requires every step completed and every
-- owned path claimed by this installation.
CREATE FUNCTION pkg.guard_installation_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  installation_state text;
  current_generation uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'installation generations are retained' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.installation_id, OLD.principal_id, OLD.number, OLD.idempotency_key,
      OLD.request_digest, OLD.operation, OLD.lock_id, OLD.expected_prior_generation_id,
      OLD.rollback_of_generation_id, OLD.plan_sha256, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.installation_id, NEW.principal_id, NEW.number, NEW.idempotency_key,
      NEW.request_digest, NEW.operation, NEW.lock_id, NEW.expected_prior_generation_id,
      NEW.rollback_of_generation_id, NEW.plan_sha256, NEW.created_at)
    OR (OLD.activation_admission_id IS NOT NULL
      AND NEW.activation_admission_id IS DISTINCT FROM OLD.activation_admission_id)
    OR (OLD.activation_admission_id IS NULL AND NEW.activation_admission_id IS NOT NULL
      AND NEW.state <> 'activating')
    OR NOT (
      (OLD.state = 'planned' AND (NEW.state IN ('rejected', 'failed')
        OR (NEW.state = 'fetching' AND OLD.operation <> 'remove')
        OR (NEW.state = 'activating' AND OLD.operation = 'remove')))
      OR (OLD.state = 'fetching' AND NEW.state IN ('verified', 'rejected', 'failed'))
      OR (OLD.state = 'verified' AND NEW.state IN ('staged', 'rejected', 'failed'))
      OR (OLD.state = 'staged' AND NEW.state IN ('activating', 'rejected', 'failed'))
      OR (OLD.state = 'activating' AND NEW.state IN ('active', 'failed'))
      OR (OLD.state = 'active' AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'installation generation transition is not allowed' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_generation_transition';
  END IF;
  IF OLD.state = 'planned' AND NEW.state IN ('fetching', 'activating') AND EXISTS (
    SELECT 1 FROM pkg.installation_step s WHERE s.generation_id = NEW.id
      AND s.executes_code AND s.hook_approval_id IS NULL) THEN
    RAISE EXCEPTION 'installation plan has an unapproved hook' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_hook_approved';
  END IF;
  IF NEW.state IN ('activating', 'active') AND OLD.state <> NEW.state THEN
    SELECT state, active_generation_id INTO installation_state, current_generation
      FROM pkg.installation WHERE id = NEW.installation_id FOR UPDATE;
    IF installation_state <> 'present'
      OR current_generation IS DISTINCT FROM NEW.expected_prior_generation_id THEN
      RAISE EXCEPTION 'installation generation is stale' USING ERRCODE = '23514',
        CONSTRAINT = 'installation_generation_current';
    END IF;
    IF NEW.lock_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM pkg.lock_artifact l
      LEFT JOIN pkg.installation_artifact i
        ON i.generation_id = NEW.id AND i.artifact_ordinal = l.ordinal
      WHERE l.lock_id = NEW.lock_id
        AND (i.artifact_id IS NULL OR NOT pkg.artifact_eligible(i.artifact_id)
          OR EXISTS (SELECT 1 FROM pkg.artifact_revocation v
            WHERE l.digest_algorithm = 'sha256' AND v.sha256 = l.digest_value))) THEN
      RAISE EXCEPTION 'installation artifacts are not currently eligible' USING ERRCODE = '23514',
        CONSTRAINT = 'installation_artifact_eligible';
    END IF;
  END IF;
  IF NEW.state = 'active' AND OLD.state <> 'active' AND (EXISTS (
      SELECT 1 FROM pkg.installation_step s WHERE s.generation_id = NEW.id
        AND (SELECT j.event FROM pkg.installation_journal j
          WHERE j.generation_id = s.generation_id AND j.step_ordinal = s.ordinal
          ORDER BY j.sequence DESC LIMIT 1) IS DISTINCT FROM 'completed')
    OR EXISTS (
      SELECT 1 FROM pkg.installation_path p
      JOIN pkg.installation n ON n.id = NEW.installation_id
      WHERE p.generation_id = NEW.id AND NOT EXISTS (
        SELECT 1 FROM pkg.installation_path_claim c
        WHERE c.target_key = n.target_key AND c.collision_key = p.collision_key
          AND c.installation_id = NEW.installation_id AND c.path = p.path
          AND c.ownership = p.ownership))) THEN
    RAISE EXCEPTION 'installation generation is not fully applied' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_generation_applied';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER pkg_installation_generation_guard BEFORE UPDATE OR DELETE ON pkg.installation_generation
  FOR EACH ROW EXECUTE FUNCTION pkg.guard_installation_generation();

-- The installation head changes only by one epoch step, never resurrects a
-- removed installation and never changes its identity.
CREATE FUNCTION pkg.guard_installation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'installations are retained' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.principal_id, OLD.idempotency_key, OLD.request_digest, OLD.target_key,
      OLD.environment, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.principal_id, NEW.idempotency_key, NEW.request_digest, NEW.target_key,
      NEW.environment, NEW.created_at)
    OR NEW.head_epoch <> OLD.head_epoch + 1
    OR OLD.state = 'removed'
    OR (NEW.active_generation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pkg.installation_generation g WHERE g.id = NEW.active_generation_id
        AND g.state = 'active' AND (NEW.state = 'removed') = (g.operation = 'remove')))
    OR (NEW.active_generation_id IS NULL AND NEW.state = 'removed') THEN
    RAISE EXCEPTION 'installation head transition is not allowed' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_head_transition';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER pkg_installation_guard BEFORE UPDATE OR DELETE ON pkg.installation
  FOR EACH ROW EXECUTE FUNCTION pkg.guard_installation();

-- Commit-time switch consistency: the head names the one active generation,
-- and an applied removal leaves the installation removed.
CREATE FUNCTION pkg.check_installation_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head uuid;
  head_state text;
  active uuid;
  active_operation text;
BEGIN
  SELECT active_generation_id, state INTO head, head_state
    FROM pkg.installation WHERE id = NEW.installation_id;
  SELECT id, operation INTO active, active_operation FROM pkg.installation_generation
    WHERE installation_id = NEW.installation_id AND state = 'active';
  IF head IS DISTINCT FROM active
    OR (head_state = 'removed') IS DISTINCT FROM (active_operation IS NOT DISTINCT FROM 'remove') THEN
    RAISE EXCEPTION 'installation head and active generation disagree' USING ERRCODE = '23514',
      CONSTRAINT = 'installation_head_active';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pkg_installation_head_active
  AFTER UPDATE OF state ON pkg.installation_generation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND (NEW.state IN ('active', 'superseded')))
  EXECUTE FUNCTION pkg.check_installation_head();
