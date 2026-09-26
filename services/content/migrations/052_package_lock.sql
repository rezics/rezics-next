-- A lock is private caller state bound to that caller's own resolution
-- receipts. The composite keys let lock segments reference them by principal.
ALTER TABLE pkg.go_resolution ADD CONSTRAINT go_resolution_principal_key UNIQUE (id, principal_id);
ALTER TABLE pkg.cargo_resolution ADD CONSTRAINT cargo_resolution_principal_key UNIQUE (id, principal_id);
ALTER TABLE pkg.npm_resolution ADD CONSTRAINT npm_resolution_principal_key UNIQUE (id, principal_id);

-- The canonical UTF-8 JSON bytes are the lock identity; manifest is their
-- parsed view. Replay or update never edits a lock: update is a new lock.
CREATE TABLE pkg.lock (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  contract_version text NOT NULL CHECK (contract_version = 'rezics-package-lock-v1'),
  canonical_bytes bytea NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 2 AND 1048576),
  lock_sha256 text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  subject_revision_id uuid,
  subject_kind text CHECK (subject_kind = 'skill-package'),
  segment_count smallint NOT NULL CHECK (segment_count BETWEEN 1 AND 16),
  artifact_count integer NOT NULL CHECK (artifact_count BETWEEN 0 AND 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (id, principal_id),
  UNIQUE (id, lock_sha256),
  UNIQUE (id, subject_revision_id),
  FOREIGN KEY (subject_revision_id, subject_kind) REFERENCES hub.revision(revision_id, kind),
  CHECK (lock_sha256 = encode(sha256(canonical_bytes), 'hex')),
  CHECK (manifest = convert_from(canonical_bytes, 'UTF8')::jsonb),
  CHECK ((subject_revision_id IS NULL) = (subject_kind IS NULL))
);
CREATE INDEX lock_principal_idx ON pkg.lock (principal_id, id);
CREATE INDEX lock_subject_idx ON pkg.lock (subject_revision_id) WHERE subject_revision_id IS NOT NULL;
CREATE TRIGGER pkg_lock_immutable BEFORE UPDATE OR DELETE ON pkg.lock
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_lock_open AFTER INSERT ON pkg.lock
  FOR EACH ROW EXECUTE FUNCTION pkg.open_aggregate('pkg_lock', 'id');

-- One ecosystem-scoped solution per segment, bound to exactly one existing
-- resolution receipt of the same principal. Segments are separated by a
-- declared process, path or ABI boundary; nothing crosses them by name.
CREATE TABLE pkg.lock_segment (
  lock_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 15),
  principal_id uuid NOT NULL,
  ecosystem text NOT NULL CHECK (ecosystem IN ('go', 'cargo', 'npm')),
  adapter_profile text NOT NULL CHECK (adapter_profile ~ '^[a-z0-9][a-z0-9.-]{0,99}$'),
  scope_kind text NOT NULL CHECK (scope_kind IN ('process', 'path', 'abi')),
  scope_label text NOT NULL CHECK (scope_label ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  go_resolution_id uuid,
  cargo_resolution_id uuid,
  npm_resolution_id uuid,
  PRIMARY KEY (lock_id, ordinal),
  UNIQUE (lock_id, ordinal, ecosystem),
  UNIQUE (lock_id, scope_kind, scope_label),
  FOREIGN KEY (lock_id, principal_id) REFERENCES pkg.lock(id, principal_id),
  FOREIGN KEY (go_resolution_id, principal_id) REFERENCES pkg.go_resolution(id, principal_id),
  FOREIGN KEY (cargo_resolution_id, principal_id) REFERENCES pkg.cargo_resolution(id, principal_id),
  FOREIGN KEY (npm_resolution_id, principal_id) REFERENCES pkg.npm_resolution(id, principal_id),
  CHECK ((ecosystem = 'go') = (go_resolution_id IS NOT NULL)
    AND (ecosystem = 'cargo') = (cargo_resolution_id IS NOT NULL)
    AND (ecosystem = 'npm') = (npm_resolution_id IS NOT NULL))
);
CREATE INDEX lock_segment_go_idx ON pkg.lock_segment (go_resolution_id) WHERE go_resolution_id IS NOT NULL;
CREATE INDEX lock_segment_cargo_idx ON pkg.lock_segment (cargo_resolution_id) WHERE cargo_resolution_id IS NOT NULL;
CREATE INDEX lock_segment_npm_idx ON pkg.lock_segment (npm_resolution_id) WHERE npm_resolution_id IS NOT NULL;
CREATE TRIGGER pkg_lock_segment_immutable BEFORE UPDATE OR DELETE ON pkg.lock_segment
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_lock_segment_open BEFORE INSERT ON pkg.lock_segment
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('pkg_lock', 'lock_id');

-- Exact artifacts per instance. A mutable tag or URL is retained beside the
-- exact locator and digest it resolved to; no digest means unverifiable.
CREATE TABLE pkg.lock_artifact (
  lock_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4095),
  segment_ordinal smallint NOT NULL,
  ecosystem text NOT NULL,
  instance_key text NOT NULL CHECK (octet_length(instance_key) BETWEEN 1 AND 1024),
  coordinate jsonb NOT NULL
    CHECK (jsonb_typeof(coordinate) = 'object' AND octet_length(coordinate::text) <= 4096),
  locator text NOT NULL CHECK (locator ~ '^https://' AND octet_length(locator) <= 2048),
  mutable_reference text CHECK (octet_length(mutable_reference) BETWEEN 1 AND 512),
  integrity_basis text NOT NULL
    CHECK (integrity_basis IN ('registry-digest', 'observed-bytes', 'unverifiable')),
  digest_algorithm text CHECK (digest_algorithm IN ('sha1', 'sha256', 'sha384', 'sha512', 'go-h1')),
  digest_value text,
  artifact_id uuid,
  artifact_sha256 text,
  PRIMARY KEY (lock_id, ordinal),
  UNIQUE (lock_id, segment_ordinal, instance_key),
  FOREIGN KEY (lock_id, segment_ordinal, ecosystem)
    REFERENCES pkg.lock_segment(lock_id, ordinal, ecosystem),
  FOREIGN KEY (artifact_id, artifact_sha256) REFERENCES pkg.artifact(id, sha256),
  CHECK ((integrity_basis = 'unverifiable') = (digest_algorithm IS NULL)),
  -- SHA digests are lowercase hex (SRI base64 is decoded); Go keeps its h1: form.
  CHECK ((digest_algorithm IS NULL AND digest_value IS NULL)
    OR (digest_algorithm = 'sha1' AND digest_value ~ '^[0-9a-f]{40}$')
    OR (digest_algorithm = 'sha256' AND digest_value ~ '^[0-9a-f]{64}$')
    OR (digest_algorithm = 'sha384' AND digest_value ~ '^[0-9a-f]{96}$')
    OR (digest_algorithm = 'sha512' AND digest_value ~ '^[0-9a-f]{128}$')
    OR (digest_algorithm = 'go-h1' AND ecosystem = 'go' AND digest_value ~ '^h1:[A-Za-z0-9+/]{43}=$')),
  CHECK ((artifact_id IS NULL) = (artifact_sha256 IS NULL)),
  CHECK (integrity_basis <> 'observed-bytes' OR (artifact_id IS NOT NULL AND digest_algorithm = 'sha256')),
  CHECK (artifact_id IS NULL OR digest_algorithm IS DISTINCT FROM 'sha256' OR digest_value = artifact_sha256)
);
CREATE INDEX lock_artifact_artifact_idx ON pkg.lock_artifact (artifact_sha256) WHERE artifact_id IS NOT NULL;
CREATE INDEX lock_artifact_digest_idx ON pkg.lock_artifact (digest_value) WHERE digest_algorithm = 'sha256';
CREATE TRIGGER pkg_lock_artifact_immutable BEFORE UPDATE OR DELETE ON pkg.lock_artifact
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_lock_artifact_open BEFORE INSERT ON pkg.lock_artifact
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('pkg_lock', 'lock_id');

-- A Skill lock maps each declared package requirement to the segment that
-- satisfies it. The shared ecosystem column forbids cross-ecosystem mapping.
CREATE TABLE pkg.lock_requirement (
  lock_id uuid NOT NULL,
  subject_revision_id uuid NOT NULL,
  requirement_ordinal smallint NOT NULL,
  ecosystem text NOT NULL,
  segment_ordinal smallint NOT NULL,
  PRIMARY KEY (lock_id, requirement_ordinal),
  FOREIGN KEY (lock_id, subject_revision_id) REFERENCES pkg.lock(id, subject_revision_id),
  FOREIGN KEY (lock_id, segment_ordinal, ecosystem)
    REFERENCES pkg.lock_segment(lock_id, ordinal, ecosystem),
  FOREIGN KEY (subject_revision_id, requirement_ordinal, ecosystem)
    REFERENCES hub.revision_requirement(revision_id, ordinal, ecosystem)
);
CREATE TRIGGER pkg_lock_requirement_immutable BEFORE UPDATE OR DELETE ON pkg.lock_requirement
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_lock_requirement_open BEFORE INSERT ON pkg.lock_requirement
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('pkg_lock', 'lock_id');

-- Commit-time lock completeness. A Skill lock succeeds only when no required
-- requirement is missing or unsupported and every required package
-- requirement in a supported ecosystem is mapped to a segment.
CREATE FUNCTION pkg.check_lock_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM pkg.lock_segment WHERE lock_id = NEW.id) <> NEW.segment_count
    OR (SELECT count(*) FROM pkg.lock_artifact WHERE lock_id = NEW.id) <> NEW.artifact_count
    OR (NEW.subject_revision_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM hub.revision_requirement r
      WHERE r.revision_id = NEW.subject_revision_id AND r.strength = 'required'
        AND (r.declaration <> 'declared' OR (r.ecosystem IN ('go', 'cargo', 'npm')
          AND NOT EXISTS (SELECT 1 FROM pkg.lock_requirement m
            WHERE m.lock_id = NEW.id AND m.requirement_ordinal = r.ordinal))))) THEN
    RAISE EXCEPTION 'package lock is incomplete' USING ERRCODE = '23514',
      CONSTRAINT = 'lock_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pkg_lock_complete AFTER INSERT ON pkg.lock
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pkg.check_lock_complete();

-- Replay re-observes every locked artifact and current eligibility. The
-- aggregate outcome is verified only when every artifact verified.
CREATE TABLE pkg.lock_replay (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  lock_id uuid NOT NULL,
  lock_sha256 text NOT NULL,
  policy text NOT NULL CHECK (policy = 'exact-artifact-replay-v1'),
  outcome text NOT NULL CHECK (outcome IN ('verified', 'unavailable')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (id, lock_id),
  FOREIGN KEY (lock_id, principal_id) REFERENCES pkg.lock(id, principal_id),
  FOREIGN KEY (lock_id, lock_sha256) REFERENCES pkg.lock(id, lock_sha256)
);
CREATE INDEX lock_replay_lock_idx ON pkg.lock_replay (lock_id, created_at DESC, id);
CREATE INDEX lock_replay_principal_idx ON pkg.lock_replay (principal_id, id);
CREATE TRIGGER pkg_lock_replay_immutable BEFORE UPDATE OR DELETE ON pkg.lock_replay
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_lock_replay_open AFTER INSERT ON pkg.lock_replay
  FOR EACH ROW EXECUTE FUNCTION pkg.open_aggregate('pkg_lock_replay', 'id');

CREATE TABLE pkg.lock_replay_artifact (
  replay_id uuid NOT NULL,
  lock_id uuid NOT NULL,
  artifact_ordinal integer NOT NULL,
  result text NOT NULL
    CHECK (result IN ('verified', 'digest-mismatch', 'unavailable', 'revoked', 'unverifiable')),
  observed_sha256 text CHECK (observed_sha256 ~ '^[0-9a-f]{64}$'),
  observed_byte_length bigint CHECK (observed_byte_length >= 0),
  artifact_id uuid,
  artifact_sha256 text,
  PRIMARY KEY (replay_id, artifact_ordinal),
  FOREIGN KEY (replay_id, lock_id) REFERENCES pkg.lock_replay(id, lock_id),
  FOREIGN KEY (lock_id, artifact_ordinal) REFERENCES pkg.lock_artifact(lock_id, ordinal),
  FOREIGN KEY (artifact_id, artifact_sha256) REFERENCES pkg.artifact(id, sha256),
  CHECK ((result = 'verified') = (artifact_id IS NOT NULL)),
  CHECK ((artifact_id IS NULL) = (artifact_sha256 IS NULL)),
  CHECK (artifact_id IS NULL OR observed_sha256 = artifact_sha256),
  CHECK (result NOT IN ('verified', 'digest-mismatch')
    OR (observed_sha256 IS NOT NULL AND observed_byte_length IS NOT NULL))
);
CREATE TRIGGER pkg_lock_replay_artifact_immutable BEFORE UPDATE OR DELETE ON pkg.lock_replay_artifact
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
CREATE TRIGGER pkg_lock_replay_artifact_open BEFORE INSERT ON pkg.lock_replay_artifact
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('pkg_lock_replay', 'replay_id');

CREATE FUNCTION pkg.check_lock_replay_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer; results integer; verified integer;
BEGIN
  SELECT artifact_count INTO expected FROM pkg.lock WHERE id = NEW.lock_id;
  SELECT count(*), count(*) FILTER (WHERE result = 'verified') INTO results, verified
    FROM pkg.lock_replay_artifact WHERE replay_id = NEW.id;
  IF results <> expected OR (NEW.outcome = 'verified') <> (verified = expected)
    OR EXISTS (
      SELECT 1 FROM pkg.lock_replay_artifact r
      JOIN pkg.lock_artifact a ON a.lock_id = r.lock_id AND a.ordinal = r.artifact_ordinal
      WHERE r.replay_id = NEW.id AND r.result = 'verified'
        AND (a.integrity_basis = 'unverifiable'
          OR (a.digest_algorithm = 'sha256' AND a.digest_value <> r.artifact_sha256)
          OR EXISTS (SELECT 1 FROM pkg.artifact_revocation v WHERE v.sha256 = r.artifact_sha256)
          OR NOT EXISTS (SELECT 1 FROM pkg.artifact f
            WHERE f.id = r.artifact_id AND f.state = 'verified'))) THEN
    RAISE EXCEPTION 'package lock replay is inconsistent' USING ERRCODE = '23514',
      CONSTRAINT = 'lock_replay_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pkg_lock_replay_complete AFTER INSERT ON pkg.lock_replay
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pkg.check_lock_replay_complete();
