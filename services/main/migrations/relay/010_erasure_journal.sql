-- One cross-owner erasure journal, retained outside restored owners beside the
-- Account deletion journal (004/006) and recovery coverage head (005) it extends.
-- It is not a second outbox or recovery frontier: the coverage head records the
-- journal epoch that a signed capture covered, and restores reconcile later epochs.
CREATE FUNCTION relay.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable relay record' USING ERRCODE = '23514';
END $$;

-- Epochs are gap-free and commit-ordered: every writer allocates through this
-- function, whose transaction-scoped lock is held until commit or rollback.
CREATE FUNCTION relay.next_erasure_epoch() RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0));
  RETURN (SELECT coalesce(max(erasure_epoch), 0) + 1 FROM relay.erasure);
END $$;

CREATE TABLE relay.erasure (
    id uuid PRIMARY KEY,
    erasure_epoch bigint NOT NULL UNIQUE CHECK (erasure_epoch >= 1),
    operation_id text NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 1 AND 200),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    kind text NOT NULL CHECK (kind IN ('account', 'resource', 'revision')),
    authority text NOT NULL CHECK (authority IN ('account_deletion', 'access_admission')),
    principal_id uuid,
    admission_id uuid UNIQUE,
    authority_epoch numeric CHECK (authority_epoch >= 0 AND authority_epoch = trunc(authority_epoch)),
    account_issuer text,
    account_subject text,
    deleted_principal_id uuid UNIQUE REFERENCES relay.account_deletion_intent(principal_id),
    stage text NOT NULL DEFAULT 'requested' CHECK (stage IN ('requested', 'fenced',
        'inventory_complete', 'deleting', 'reconciling', 'verified', 'blocked')),
    suppression_status text NOT NULL DEFAULT 'pending'
        CHECK (suppression_status IN ('pending', 'suppressed')),
    destruction_status text NOT NULL DEFAULT 'pending' CHECK (destruction_status IN
        ('pending', 'in_progress', 'retained', 'destroyed', 'blocked')),
    blocked_reason text CHECK (length(blocked_reason) BETWEEN 1 AND 500),
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    suppressed_at timestamptz,
    verified_at timestamptz,
    FOREIGN KEY (account_issuer, account_subject)
        REFERENCES relay.account_subject_deletion(issuer, account_subject),
    CHECK ((kind = 'account') = (account_issuer IS NOT NULL AND account_subject IS NOT NULL)),
    CHECK (kind = 'account' OR deleted_principal_id IS NULL),
    CHECK (authority <> 'account_deletion' OR kind = 'account'),
    CHECK (authority <> 'access_admission'
        OR (principal_id IS NOT NULL AND admission_id IS NOT NULL AND authority_epoch IS NOT NULL)),
    CHECK ((suppression_status = 'suppressed') = (suppressed_at IS NOT NULL)),
    CHECK (stage IN ('requested', 'blocked') OR suppression_status = 'suppressed'),
    CHECK (stage <> 'requested' OR destruction_status = 'pending'),
    CHECK ((stage = 'verified') = (verified_at IS NOT NULL)),
    CHECK (stage <> 'verified' OR destruction_status IN ('retained', 'destroyed')),
    CHECK ((stage = 'blocked' OR destruction_status = 'blocked') = (blocked_reason IS NOT NULL))
);
CREATE UNIQUE INDEX erasure_account_subject ON relay.erasure (account_issuer, account_subject)
    WHERE kind = 'account';
CREATE INDEX erasure_open ON relay.erasure (stage, erasure_epoch) WHERE stage <> 'verified';

-- Identity and authority never change; suppression never regresses, so a later
-- status update cannot resurrect erased data. Journal entries are never deleted.
CREATE FUNCTION relay.erasure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retained erasure journal entry cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.erasure_epoch, OLD.operation_id, OLD.request_digest, OLD.kind, OLD.authority,
      OLD.principal_id, OLD.admission_id, OLD.authority_epoch, OLD.account_issuer,
      OLD.account_subject, OLD.requested_at)
     IS DISTINCT FROM
     (NEW.id, NEW.erasure_epoch, NEW.operation_id, NEW.request_digest, NEW.kind, NEW.authority,
      NEW.principal_id, NEW.admission_id, NEW.authority_epoch, NEW.account_issuer,
      NEW.account_subject, NEW.requested_at) THEN
    RAISE EXCEPTION 'immutable erasure journal identity' USING ERRCODE = '23514';
  END IF;
  IF (OLD.deleted_principal_id IS NOT NULL
      AND NEW.deleted_principal_id IS DISTINCT FROM OLD.deleted_principal_id)
     OR (OLD.suppression_status = 'suppressed'
      AND (NEW.suppression_status <> 'suppressed' OR NEW.suppressed_at IS DISTINCT FROM OLD.suppressed_at)) THEN
    RAISE EXCEPTION 'erasure suppression cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_guard BEFORE UPDATE OR DELETE ON relay.erasure
    FOR EACH ROW EXECUTE FUNCTION relay.erasure_guard();

-- Exact affected references; an erased reference is reported erased, never retargeted.
CREATE TABLE relay.erasure_target (
    erasure_id uuid NOT NULL REFERENCES relay.erasure(id),
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 256),
    owner text NOT NULL,
    target_kind text NOT NULL,
    target_ref text NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 512),
    PRIMARY KEY (erasure_id, ordinal),
    UNIQUE (erasure_id, owner, target_kind, target_ref),
    CHECK ((target_kind, owner) IN (('principal', 'access'), ('content_revision', 'content'),
        ('content_variant', 'content'), ('semantic_revision', 'graph'), ('resource', 'graph'),
        ('source_observation', 'source'), ('object', 'object')))
);
CREATE INDEX erasure_target_ref ON relay.erasure_target (owner, target_kind, target_ref, erasure_id);
CREATE TRIGGER erasure_target_immutable BEFORE UPDATE OR DELETE ON relay.erasure_target
    FOR EACH ROW EXECUTE FUNCTION relay.no_mutation();

-- Every retained Account subject tombstone is one Account erasure. The request
-- digest is sha256(issuer || LF || subject), so backfill and hook agree.
CREATE FUNCTION relay.account_subject_erasure_digest(issuer text, subject text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(issuer || E'\n' || subject, 'UTF8')), 'hex')
$$;

CREATE FUNCTION relay.journal_account_subject_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  digest text := relay.account_subject_erasure_digest(NEW.issuer, NEW.account_subject);
BEGIN
  INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest, kind, authority,
      account_issuer, account_subject, requested_at)
  VALUES (gen_random_uuid(), relay.next_erasure_epoch(), 'account-subject-deletion:' || digest,
      digest, 'account', 'account_deletion', NEW.issuer, NEW.account_subject, NEW.retained_at)
  ON CONFLICT (account_issuer, account_subject) WHERE kind = 'account' DO NOTHING;
  RETURN NULL;
END $$;

-- Existing tombstones enter the journal as unverified requests: their Access fence
-- and Account absence are proved by reconciliation, not assumed by this migration.
INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest, kind, authority,
    account_issuer, account_subject, requested_at)
SELECT gen_random_uuid(),
       row_number() OVER (ORDER BY retained_at, issuer, account_subject),
       'account-subject-deletion:' || relay.account_subject_erasure_digest(issuer, account_subject),
       relay.account_subject_erasure_digest(issuer, account_subject),
       'account', 'account_deletion', issuer, account_subject, retained_at
FROM relay.account_subject_deletion;

CREATE TRIGGER account_subject_deletion_journal AFTER INSERT ON relay.account_subject_deletion
    FOR EACH ROW EXECUTE FUNCTION relay.journal_account_subject_deletion();

-- NULL means the retained capture predates erasure journal coverage, so a restore
-- must reconcile every journal entry. A later capture cannot claim an older epoch.
ALTER TABLE relay.recovery_coverage_head
    ADD COLUMN erasure_epoch bigint REFERENCES relay.erasure(erasure_epoch);

CREATE FUNCTION relay.recovery_coverage_erasure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erasure_epoch IS NOT NULL
     AND (NEW.erasure_epoch IS NULL OR NEW.erasure_epoch < OLD.erasure_epoch) THEN
    RAISE EXCEPTION 'recovery coverage erasure epoch cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_coverage_erasure_guard BEFORE UPDATE ON relay.recovery_coverage_head
    FOR EACH ROW EXECUTE FUNCTION relay.recovery_coverage_erasure_guard();
