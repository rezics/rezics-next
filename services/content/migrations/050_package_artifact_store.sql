-- One confined relative path grammar for Skill files, installation inventory
-- and symlink targets: no absolute, drive, backslash, empty, '.' or '..'
-- segment and no control character. Platform folding stays in the adapter.
CREATE FUNCTION pkg.confined_path(path text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT octet_length(path) BETWEEN 1 AND 1024
    AND path ~ '^[^/\\]+(/[^/\\]+)*$'
    AND path !~ '(^|/)\.\.?(/|$)'
    AND path !~ '^[A-Za-z]:'
    AND path !~ '[[:cntrl:]]'
$$;

-- Immutable multi-row aggregates (Hub revisions, locks, replays, installation
-- plans, observations, consent ceilings) accept child rows only in the
-- transaction that inserted their parent: the parent's AFTER INSERT trigger
-- opens a transaction-local marker and each child's BEFORE INSERT trigger
-- requires it. Commit-time triggers then check completeness once. Insert a
-- parent's children before the next parent of the same kind.
CREATE FUNCTION pkg.open_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opened text;
BEGIN
  EXECUTE format('SELECT ($1).%I::text', TG_ARGV[1]) USING NEW INTO opened;
  PERFORM set_config('rezics.open_' || TG_ARGV[0], opened, true);
  RETURN NULL;
END $$;
CREATE FUNCTION pkg.require_open_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent text;
BEGIN
  EXECUTE format('SELECT ($1).%I::text', TG_ARGV[1]) USING NEW INTO parent;
  IF current_setting('rezics.open_' || TG_ARGV[0], true) IS DISTINCT FROM parent THEN
    RAISE EXCEPTION 'immutable % aggregate is sealed', TG_ARGV[0] USING ERRCODE = '23514',
      CONSTRAINT = 'aggregate_open';
  END IF;
  RETURN NEW;
END $$;

-- Package and Skill file bytes live in the RustFS bucket behind Main's
-- S3ImmutableObjects adapter. PostgreSQL keeps the reference, integrity and
-- retention domain; locks, installations and Hub revisions pin rows by FK.
-- Public-origin bytes dedupe by digest; private uploads never share a key
-- with another principal, so object existence cannot disclose an upload.
CREATE TABLE pkg.artifact (
  id uuid PRIMARY KEY,
  retention_domain text NOT NULL CHECK (retention_domain IN ('public-origin', 'principal-private')),
  owner_principal_id uuid,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  media_type text NOT NULL CHECK (media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  object_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'quarantined'
    CHECK (state IN ('quarantined', 'verified', 'rejected', 'erased')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (retention_domain, owner_principal_id, sha256),
  UNIQUE (id, sha256),
  CHECK ((retention_domain = 'public-origin') = (owner_principal_id IS NULL)),
  CHECK (object_key = CASE retention_domain
    WHEN 'public-origin' THEN 'package/artifact/public/sha256/' || sha256
    ELSE 'package/artifact/private/' || owner_principal_id::text || '/sha256/' || sha256 END),
  CHECK ((state = 'quarantined') = (settled_at IS NULL))
);
CREATE INDEX artifact_sha256_idx ON pkg.artifact (sha256);

-- Quarantined bytes are verified or rejected once; erasure is a terminal
-- tombstone that keeps references resolvable as unavailable.
CREATE FUNCTION pkg.guard_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'package artifact references are retained' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.retention_domain, OLD.owner_principal_id, OLD.sha256, OLD.byte_length,
      OLD.media_type, OLD.object_key, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.retention_domain, NEW.owner_principal_id, NEW.sha256, NEW.byte_length,
      NEW.media_type, NEW.object_key, NEW.created_at)
    OR NOT ((OLD.state = 'quarantined' AND NEW.state IN ('verified', 'rejected', 'erased'))
      OR (OLD.state IN ('verified', 'rejected') AND NEW.state = 'erased')) THEN
    RAISE EXCEPTION 'package artifact transition is not allowed' USING ERRCODE = '23514',
      CONSTRAINT = 'artifact_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pkg_artifact_guard BEFORE UPDATE OR DELETE ON pkg.artifact
  FOR EACH ROW EXECUTE FUNCTION pkg.guard_artifact();

-- Revocation applies to the exact bytes in every retention domain. It is
-- append-only: replay, activation and rollback consult it, so a revoked
-- artifact cannot be resurrected by an older lock or generation.
CREATE TABLE pkg.artifact_revocation (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL
    CHECK (reason IN ('malicious', 'integrity', 'rights', 'provider-withdrawn', 'policy')),
  basis jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object' AND octet_length(basis::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX artifact_revocation_sha256_idx ON pkg.artifact_revocation (sha256);
CREATE TRIGGER pkg_artifact_revocation_immutable BEFORE UPDATE OR DELETE ON pkg.artifact_revocation
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
