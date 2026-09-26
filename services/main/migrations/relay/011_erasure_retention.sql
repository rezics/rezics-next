-- Per-store retention. Every copy location an erasure must account for is one
-- retention domain with explicit owner, storage class, custody, expiry and hold.
-- Dispositions report suppression and physical destruction separately for each
-- erasure and domain; a retained copy stays retained until evidence says otherwise.
CREATE TABLE relay.retention_domain (
    id uuid PRIMARY KEY,
    label text NOT NULL UNIQUE CHECK (label ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
    owner text NOT NULL CHECK (owner IN
        ('account', 'access', 'content', 'source', 'graph', 'object', 'relay')),
    store text NOT NULL CHECK (store IN ('postgresql', 'postgresql_wal', 'tdb2',
        'tdb2_generation', 'lucene', 'object_store', 'cache', 'delivery', 'log', 'audit',
        'export_artifact')),
    custody text NOT NULL CHECK (custody IN ('live', 'derived', 'backup', 'archive', 'retired')),
    expires_at timestamptz,
    hold_reason text CHECK (length(hold_reason) BETWEEN 1 AND 500),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'expired', 'destroyed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    retired_at timestamptz,
    CHECK ((state = 'active') = (retired_at IS NULL)),
    CHECK (custody NOT IN ('backup', 'archive', 'retired')
        OR expires_at IS NOT NULL OR hold_reason IS NOT NULL)
);
CREATE INDEX retention_domain_active ON relay.retention_domain (owner, store, id)
    WHERE state = 'active';

CREATE TABLE relay.erasure_disposition (
    erasure_id uuid NOT NULL REFERENCES relay.erasure(id),
    domain_id uuid NOT NULL REFERENCES relay.retention_domain(id),
    suppression text NOT NULL DEFAULT 'pending'
        CHECK (suppression IN ('not_applicable', 'pending', 'suppressed')),
    destruction text NOT NULL DEFAULT 'pending' CHECK (destruction IN ('pending', 'not_present',
        'destroyed', 'sanitized', 'expired', 'retained', 'blocked')),
    retained_until timestamptz,
    reason text CHECK (length(reason) BETWEEN 1 AND 500),
    evidence_digest text CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (erasure_id, domain_id),
    CHECK (destruction <> 'retained' OR retained_until IS NOT NULL OR reason IS NOT NULL),
    CHECK (destruction <> 'blocked' OR reason IS NOT NULL),
    CHECK (destruction NOT IN ('not_present', 'destroyed', 'sanitized', 'expired')
        OR evidence_digest IS NOT NULL)
);
CREATE INDEX erasure_disposition_domain ON relay.erasure_disposition
    (domain_id, destruction, erasure_id);

-- Terminal destruction evidence and applied suppression are never withdrawn.
CREATE FUNCTION relay.erasure_disposition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'erasure disposition cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (OLD.erasure_id, OLD.domain_id) IS DISTINCT FROM (NEW.erasure_id, NEW.domain_id)
     OR (OLD.suppression = 'suppressed' AND NEW.suppression <> 'suppressed')
     OR (OLD.destruction IN ('not_present', 'destroyed', 'sanitized', 'expired')
      AND (NEW.destruction, NEW.evidence_digest) IS DISTINCT FROM (OLD.destruction, OLD.evidence_digest)) THEN
    RAISE EXCEPTION 'erasure disposition cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_disposition_guard BEFORE UPDATE OR DELETE ON relay.erasure_disposition
    FOR EACH ROW EXECUTE FUNCTION relay.erasure_disposition_guard();
