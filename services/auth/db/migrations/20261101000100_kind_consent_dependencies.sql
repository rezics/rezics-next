-- Auth's purpose-bound enrollment and writer-before-visibility closure for
-- native Collection Kind consumers. References are lookup keys, never grants.
-- migrate:up

CREATE TABLE auth_kind_consent_dependency (
  enrollment_seq bigserial PRIMARY KEY,
  reference_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  consumer_key_hash bytea NOT NULL UNIQUE CHECK(octet_length(consumer_key_hash)=32),
  account_id text NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 1024),
  client_id text NOT NULL CHECK(octet_length(client_id) BETWEEN 1 AND 1024),
  requested_scopes text[] NOT NULL CHECK(cardinality(requested_scopes)<=512),
  effective_scopes text[] NOT NULL CHECK(cardinality(effective_scopes)<=512),
  consent_revision bigint NOT NULL CHECK(consent_revision>=0),
  client_scopes text[] NOT NULL CHECK(cardinality(client_scopes)<=512),
  client_first_party boolean NOT NULL,
  consumer_route text NOT NULL CHECK(octet_length(consumer_route) BETWEEN 1 AND 1024),
  owner_account_id text NOT NULL CHECK(octet_length(owner_account_id) BETWEEN 1 AND 1024),
  collection_id text NOT NULL CHECK(octet_length(collection_id) BETWEEN 1 AND 1024),
  preparation_id text NOT NULL CHECK(octet_length(preparation_id) BETWEEN 1 AND 1024),
  origin_id text NOT NULL CHECK(octet_length(origin_id) BETWEEN 1 AND 1024),
  active boolean NOT NULL DEFAULT true,
  fenced_transition_id uuid,
  receipt_reference text CHECK(receipt_reference IS NULL OR octet_length(receipt_reference)<=1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fenced_at timestamptz,
  CHECK((fenced_transition_id IS NULL)=(receipt_reference IS NULL)),
  CHECK(active OR (fenced_transition_id IS NOT NULL AND fenced_at IS NOT NULL))
);

CREATE INDEX auth_kind_consent_by_client ON auth_kind_consent_dependency(client_id,enrollment_seq) WHERE active;
CREATE INDEX auth_kind_consent_by_account_client
  ON auth_kind_consent_dependency(account_id,client_id,enrollment_seq) WHERE active;

CREATE TABLE auth_kind_consent_transition (
  transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transition_key text NOT NULL UNIQUE CHECK(octet_length(transition_key) BETWEEN 1 AND 1024),
  transition_kind text NOT NULL CHECK(transition_kind IN ('consent','client','restore')),
  client_id text NOT NULL CHECK(octet_length(client_id) BETWEEN 1 AND 1024),
  account_id text CHECK(account_id IS NULL OR octet_length(account_id) BETWEEN 1 AND 1024),
  target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=8192),
  frontier_seq bigint NOT NULL CHECK(frontier_seq>=0),
  after_seq bigint NOT NULL DEFAULT 0 CHECK(after_seq>=0 AND after_seq<=frontier_seq),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','applied')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  CHECK((transition_kind='consent')=(account_id IS NOT NULL)),
  CHECK((transition_kind='restore')=(client_id='*' AND account_id IS NULL)),
  CHECK((state='applied')=(applied_at IS NOT NULL))
);

CREATE INDEX auth_kind_consent_transition_pending_client
  ON auth_kind_consent_transition(client_id,account_id,transition_id) WHERE state<>'applied';

CREATE FUNCTION auth_kind_consent_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transition auth_kind_consent_transition%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.transition_id,NEW.transition_key,NEW.transition_kind,NEW.client_id,NEW.account_id,NEW.target,NEW.frontier_seq,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.transition_id,OLD.transition_key,OLD.transition_kind,OLD.client_id,OLD.account_id,OLD.target,OLD.frontier_seq,OLD.created_at) THEN
      RAISE EXCEPTION 'Kind consent transition identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.after_seq<OLD.after_seq OR
       (OLD.state='pending' AND NEW.state NOT IN ('pending','ready')) OR
       (OLD.state='ready' AND NEW.state NOT IN ('ready','applied')) OR
       OLD.state='applied' AND ROW(NEW.after_seq,NEW.state,NEW.updated_at,NEW.applied_at)
         IS DISTINCT FROM ROW(OLD.after_seq,OLD.state,OLD.updated_at,OLD.applied_at) THEN
      RAISE EXCEPTION 'Kind consent transition progress is invalid' USING ERRCODE='23514';
    END IF;
    IF NEW.state IN ('ready','applied') AND EXISTS (
      SELECT 1 FROM auth_kind_consent_dependency d
      WHERE d.active AND (NEW.transition_kind='restore' OR
        (d.client_id=NEW.client_id AND (NEW.account_id IS NULL OR d.account_id=NEW.account_id)))
        AND d.enrollment_seq<=NEW.frontier_seq
    ) THEN
      RAISE EXCEPTION 'Kind consent transition has unfenced consumers' USING ERRCODE='23514';
    END IF;
    IF NEW.state='applied' AND OLD.state<>'ready' THEN
      RAISE EXCEPTION 'Kind consent transition was not ready' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.state<>'applied' THEN RAISE EXCEPTION 'Kind consent transition is unresolved' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER auth_kind_consent_transition_guard
  BEFORE UPDATE OR DELETE ON auth_kind_consent_transition
  FOR EACH ROW EXECUTE FUNCTION auth_kind_consent_transition_guard();

CREATE FUNCTION auth_kind_consent_dependency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('auth-kind-consent-frontier',0));
    IF EXISTS (
      SELECT 1 FROM auth_kind_consent_transition t
      WHERE t.state<>'applied' AND (t.transition_kind='restore' OR
        (t.client_id=NEW.client_id AND (t.account_id IS NULL OR t.account_id=NEW.account_id)))
    ) THEN
      RAISE EXCEPTION 'Kind consent enrollment frontier is closed' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.active THEN RAISE EXCEPTION 'Active Kind consent dependency cannot be erased' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.reference_id,NEW.consumer_key_hash,NEW.account_id,NEW.client_id,NEW.requested_scopes,
           NEW.effective_scopes,NEW.consent_revision,NEW.client_scopes,NEW.client_first_party,NEW.consumer_route,NEW.owner_account_id,
           NEW.collection_id,NEW.preparation_id,NEW.origin_id,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.reference_id,OLD.consumer_key_hash,OLD.account_id,OLD.client_id,OLD.requested_scopes,
           OLD.effective_scopes,OLD.consent_revision,OLD.client_scopes,OLD.client_first_party,OLD.consumer_route,OLD.owner_account_id,
           OLD.collection_id,OLD.preparation_id,OLD.origin_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Kind consent consumer binding is immutable' USING ERRCODE='23514';
    END IF;
    IF (NOT OLD.active AND NEW.active) OR
       (OLD.fenced_transition_id IS NOT NULL AND ROW(NEW.fenced_transition_id,NEW.receipt_reference,NEW.fenced_at)
         IS DISTINCT FROM ROW(OLD.fenced_transition_id,OLD.receipt_reference,OLD.fenced_at)) THEN
      RAISE EXCEPTION 'Kind consent dependency fence is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF OLD.active AND NOT NEW.active THEN
    IF NEW.fenced_transition_id IS NULL OR NEW.receipt_reference IS NULL OR NEW.fenced_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM auth_kind_consent_transition t
      WHERE t.transition_id=NEW.fenced_transition_id AND t.state='pending'
        AND (t.transition_kind='restore' OR (t.client_id=OLD.client_id AND (t.account_id IS NULL OR t.account_id=OLD.account_id)))
        AND OLD.enrollment_seq<=t.frontier_seq
        AND current_setting('auth.kind_consent_transition_id',true)=t.transition_id::text
    ) THEN RAISE EXCEPTION 'Kind consent dependency fence is unverified' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_kind_consent_dependency_guard
  BEFORE INSERT OR UPDATE OR DELETE ON auth_kind_consent_dependency
  FOR EACH ROW EXECUTE FUNCTION auth_kind_consent_dependency_guard();

CREATE FUNCTION auth_kind_consent_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_key text;
  client_key text;
  operation text;
  transition auth_kind_consent_transition%ROWTYPE;
  required boolean := false;
  authority_change boolean := false;
BEGIN
  IF TG_TABLE_NAME='auth_consent' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    account_key:=CASE WHEN TG_OP='DELETE' THEN OLD.account_id ELSE NEW.account_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=OLD.account_id AND d.client_id=OLD.client_id);
      operation:='consent-delete';
    ELSIF TG_OP='INSERT' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:='consent-upsert';
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.pending_scopes,NEW.pending_reference) IS DISTINCT FROM ROW(OLD.scopes,OLD.pending_scopes,OLD.pending_reference);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:=CASE WHEN NEW.scopes IS NOT DISTINCT FROM OLD.scopes THEN 'consent-pending' ELSE 'consent-upsert' END;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.first_party,NEW.erasure_fenced,NEW.disabled) IS DISTINCT FROM ROW(OLD.scopes,OLD.first_party,OLD.erasure_fenced,OLD.disabled);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:=CASE WHEN TG_OP='UPDATE' AND
      ROW(NEW.disabled,NEW.erasure_fenced) IS DISTINCT FROM ROW(OLD.disabled,OLD.erasure_fenced)
      THEN 'client-erasure-fence' ELSE 'client-config' END;
  ELSIF TG_TABLE_NAME='auth_client_reduction' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    authority_change:=TG_OP<>'UPDATE';
    required:=authority_change AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    operation:=CASE WHEN TG_OP='DELETE' THEN 'client-reduction-finish' ELSE 'client-reduction-start' END;
  ELSIF TG_TABLE_NAME='auth_client_coverage' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=(TG_OP='INSERT' AND NEW.ready) OR
        (TG_OP='UPDATE' AND NEW.ready IS DISTINCT FROM OLD.ready);
      required:=authority_change AND
        EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:='client-coverage';
  ELSE
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT authority_change THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  -- This is the database-side serialization point for legacy/direct writers.
  -- A direct mutation cannot race an enrollment snapshot or slip through after
  -- a page has fenced its rows but before the exact transition is applied.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth-kind-consent-frontier',0));
  IF TG_TABLE_NAME='auth_consent' THEN
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=account_key AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  ELSE
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  END IF;
  IF NOT required THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  SELECT * INTO transition FROM auth_kind_consent_transition t
  WHERE t.transition_id::text=current_setting('auth.kind_consent_transition_id',true)
    AND t.state='ready' AND t.client_id=client_key
    AND (t.account_id IS NULL OR t.account_id=account_key)
    AND (t.target->>'operation'=operation OR
      (TG_TABLE_NAME='auth_client_coverage' AND TG_OP='INSERT' AND operation='client-coverage'
       AND t.target->>'operation'='client-config'));
  IF NOT FOUND THEN RAISE EXCEPTION 'Kind consent dependency closure required before Auth write' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key
      AND (transition.account_id IS NULL OR d.account_id=transition.account_id)
      AND d.enrollment_seq<=transition.frontier_seq) THEN
    RAISE EXCEPTION 'Kind consent dependency closure is incomplete' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='auth_consent' THEN
    IF operation='consent-upsert' AND TG_OP<>'DELETE' AND (
      transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
      (transition.target ? 'pendingScopes' AND transition.target->'pendingScopes' IS DISTINCT FROM COALESCE(to_jsonb(NEW.pending_scopes),'null'::jsonb)) OR
      (transition.target ? 'pendingReference' AND transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference)
    ) THEN
      RAISE EXCEPTION 'Kind consent transition target mismatch' USING ERRCODE='23514';
    END IF;
    IF operation='consent-pending' AND TG_OP='UPDATE' AND (
      transition.target->'pendingScopes' IS DISTINCT FROM to_jsonb(NEW.pending_scopes) OR
      transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference
    ) THEN RAISE EXCEPTION 'Kind pending consent transition target mismatch' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='auth_client' AND TG_OP='UPDATE' AND operation='client-config' AND (
    transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
    transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}'
  ) THEN RAISE EXCEPTION 'Kind client transition target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client' AND TG_OP='UPDATE' AND operation='client-erasure-fence' AND (
    NOT NEW.erasure_fenced OR NOT NEW.disabled
  ) THEN RAISE EXCEPTION 'Kind client erasure fence target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client' AND TG_OP='DELETE' AND transition.target->>'operation'<>'client-delete' THEN
    RAISE EXCEPTION 'Kind client deletion transition target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_coverage' AND TG_OP<>'DELETE' AND
    transition.target->>'operation'='client-coverage' AND
    transition.target->>'ready' IS DISTINCT FROM to_jsonb(NEW.ready)#>>'{}' THEN
    RAISE EXCEPTION 'Kind client coverage transition target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_coverage' AND TG_OP='INSERT' AND
    transition.target->>'operation'='client-config' AND
    (NOT NEW.ready OR NOT EXISTS(
      SELECT 1 FROM auth_client c WHERE c.client_id=client_key
        AND to_jsonb(c.scopes)=transition.target->'scopes'
        AND (to_jsonb(c.first_party)#>>'{}')=transition.target->>'firstParty'
    )) THEN
    RAISE EXCEPTION 'Kind client coverage is outside client transition target' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_reduction' AND TG_OP='INSERT' AND (
    transition.target->>'operationId' IS DISTINCT FROM NEW.operation_id OR
    transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
    transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}'
  ) THEN RAISE EXCEPTION 'Kind client reduction start target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_reduction' AND TG_OP='DELETE' AND (
    transition.target->>'operationId' IS DISTINCT FROM OLD.operation_id OR
    transition.target->'scopes' IS DISTINCT FROM to_jsonb(OLD.scopes) OR
    transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(OLD.first_party)#>>'{}'
  ) THEN RAISE EXCEPTION 'Kind client reduction finish target mismatch' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER auth_kind_consent_writer_guard
  BEFORE INSERT OR UPDATE OR DELETE ON auth_consent
  FOR EACH ROW EXECUTE FUNCTION auth_kind_consent_writer_guard();
CREATE TRIGGER auth_kind_client_writer_guard
  BEFORE UPDATE OR DELETE ON auth_client
  FOR EACH ROW EXECUTE FUNCTION auth_kind_consent_writer_guard();
CREATE TRIGGER auth_kind_client_reduction_writer_guard
  BEFORE INSERT OR DELETE ON auth_client_reduction
  FOR EACH ROW EXECUTE FUNCTION auth_kind_consent_writer_guard();
CREATE TRIGGER auth_kind_client_coverage_writer_guard
  BEFORE INSERT OR UPDATE OR DELETE ON auth_client_coverage
  FOR EACH ROW EXECUTE FUNCTION auth_kind_consent_writer_guard();

-- migrate:down
DROP TRIGGER IF EXISTS auth_kind_client_coverage_writer_guard ON auth_client_coverage;
DROP TRIGGER IF EXISTS auth_kind_client_reduction_writer_guard ON auth_client_reduction;
DROP TRIGGER IF EXISTS auth_kind_client_writer_guard ON auth_client;
DROP TRIGGER IF EXISTS auth_kind_consent_writer_guard ON auth_consent;
DROP FUNCTION IF EXISTS auth_kind_consent_writer_guard();
DROP TRIGGER IF EXISTS auth_kind_consent_dependency_guard ON auth_kind_consent_dependency;
DROP FUNCTION IF EXISTS auth_kind_consent_dependency_guard();
DROP TRIGGER IF EXISTS auth_kind_consent_transition_guard ON auth_kind_consent_transition;
DROP FUNCTION IF EXISTS auth_kind_consent_transition_guard();
DROP TABLE IF EXISTS auth_kind_consent_transition;
DROP TABLE IF EXISTS auth_kind_consent_dependency;
