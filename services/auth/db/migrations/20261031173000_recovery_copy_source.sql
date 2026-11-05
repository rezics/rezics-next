-- migrate:up
-- Quiesce the original producer while installing its transactional Source cut.
LOCK TABLE verification IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE auth_recovery_copy_source (
  delivery_id text PRIMARY KEY CHECK(octet_length(delivery_id) BETWEEN 1 AND 1024)
    -- Reserve room for encoded status/keys within each <=1KiB locator.
    CHECK(octet_length(to_json(delivery_id)::text)<=768),
  producer text NOT NULL DEFAULT 'better-auth-reset/1.8.0-beta.2/source-v1'
    CHECK(producer='better-auth-reset/1.8.0-beta.2/source-v1'),
  source_component text NOT NULL DEFAULT 'verification' CHECK(source_component='verification'),
  account_id text NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 1024),
  erasure_human_id text CHECK(octet_length(erasure_human_id)<=1024),
  erasure_operator_id text CHECK(octet_length(erasure_operator_id)<=1024),
  erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024),
  erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- No receiving owner is installed. NULL is unknown, never a sink namespace.
  sink_generation text CHECK(sink_generation IS NULL),
  custody text NOT NULL DEFAULT 'unknown' CHECK(custody='unknown'),
  status text NOT NULL DEFAULT 'intent' CHECK(status IN ('intent','in-flight','unknown')),
  code text NOT NULL DEFAULT 'receiving-adapter-unavailable' CHECK(code IN (
    'receiving-adapter-unavailable','receiving-result-unavailable','legacy-void',
    'unsupported-result','callback-failed','callback-timeout')),
  attempts smallint NOT NULL DEFAULT 0 CHECK(attempts IN (0,1)),
  attempted_at timestamptz,
  erasure_role_version smallint NOT NULL DEFAULT 1 CHECK(erasure_role_version=1),
  erasure_role_xid bigint NOT NULL
);
CREATE INDEX recovery_copy_subject ON auth_recovery_copy_source(account_id,delivery_id);
CREATE INDEX recovery_copy_human ON auth_recovery_copy_source(erasure_human_id,delivery_id);
CREATE INDEX recovery_copy_operator ON auth_recovery_copy_source(erasure_operator_id,delivery_id);
CREATE INDEX recovery_copy_client_owner ON auth_recovery_copy_source(erasure_client_owner_id,delivery_id);
CREATE INDEX recovery_copy_source_owner ON auth_recovery_copy_source(erasure_source_client_owner_id,delivery_id);
CREATE INDEX native_role_auth_recovery_copy_source_pending ON auth_recovery_copy_source(delivery_id)
  WHERE erasure_role_version=0;

CREATE FUNCTION auth_recovery_copy_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source verification%ROWTYPE; owner_id text;
BEGIN
  -- The source is the native INSERT in THIS transaction, not a later observation
  -- or a caller-supplied role/version/settings assertion. Derive every role and
  -- timestamp from its exact key. Never copy identifier, value or their hashes.
  SELECT id,value,erasure_account_id,erasure_human_id,erasure_operator_id,erasure_client_owner_id,
    erasure_source_client_owner_id,erasure_role_xid,erasure_role_version,erasure_format,"createdAt","expiresAt"
    INTO source.id,source.value,source.erasure_account_id,source.erasure_human_id,source.erasure_operator_id,
      source.erasure_client_owner_id,source.erasure_source_client_owner_id,source.erasure_role_xid,
      source.erasure_role_version,source.erasure_format,source."createdAt",source."expiresAt"
    FROM verification WHERE id=NEW.delivery_id;
  IF NOT FOUND OR source.erasure_role_xid IS DISTINCT FROM txid_current()
    OR source.erasure_role_version<>1 OR source.erasure_format IS DISTINCT FROM 'reset-v1'
    OR source.erasure_account_id IS NULL OR source.erasure_account_id IS DISTINCT FROM source.value THEN
    RAISE EXCEPTION 'Auth recovery Source provenance unavailable' USING ERRCODE='55000';
  END IF;
  NEW.account_id:=source.erasure_account_id;
  NEW.erasure_human_id:=source.erasure_human_id;
  NEW.erasure_operator_id:=source.erasure_operator_id;
  NEW.erasure_client_owner_id:=source.erasure_client_owner_id;
  NEW.erasure_source_client_owner_id:=source.erasure_source_client_owner_id;
  NEW.created_at:=source."createdAt";
  NEW.expires_at:=source."expiresAt";
  NEW.erasure_role_xid:=source.erasure_role_xid;
  NEW.erasure_role_version:=1;
  IF NEW.status<>'intent' OR NEW.attempts<>0 OR NEW.attempted_at IS NOT NULL
    OR NEW.code<>'receiving-adapter-unavailable' THEN
    RAISE EXCEPTION 'Auth recovery Source must begin at intent' USING ERRCODE='55000';
  END IF;
  FOREACH owner_id IN ARRAY ARRAY[NEW.account_id,NEW.erasure_human_id,NEW.erasure_operator_id,
      NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id] LOOP
    PERFORM auth_erasure_admit(owner_id);
    IF EXISTS(SELECT 1 FROM auth_erasure WHERE account_id=owner_id) THEN
      RAISE EXCEPTION 'Auth erasure fence' USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_copy_capture BEFORE INSERT ON auth_recovery_copy_source
  FOR EACH ROW EXECUTE FUNCTION auth_recovery_copy_capture();

CREATE FUNCTION auth_recovery_copy_producer_cut() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Native role projection finishes after INSERT but inside its supported
  -- adapter transaction. This commit-time guard refuses old reset writers.
  IF EXISTS(SELECT 1 FROM verification WHERE id=NEW.id AND erasure_format='reset-v1'
      AND erasure_role_xid=txid_current())
    AND NOT EXISTS(SELECT 1 FROM auth_recovery_copy_source WHERE delivery_id=NEW.id) THEN
    RAISE EXCEPTION 'Auth recovery Source producer unavailable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zz_recovery_copy_producer_cut AFTER INSERT ON verification
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION auth_recovery_copy_producer_cut();

CREATE FUNCTION auth_recovery_copy_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
  -- Only a receiving owner's durable verified disposition could authorize
  -- minimization. There is no such installed adapter in this Source slice.
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Auth recovery receiving disposition unavailable' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.delivery_id,NEW.producer,NEW.source_component,NEW.account_id,
      NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id,
      NEW.created_at,NEW.expires_at,NEW.sink_generation,NEW.custody,NEW.erasure_role_version,NEW.erasure_role_xid)
    IS DISTINCT FROM ROW(OLD.delivery_id,OLD.producer,OLD.source_component,OLD.account_id,
      OLD.erasure_human_id,OLD.erasure_operator_id,OLD.erasure_client_owner_id,OLD.erasure_source_client_owner_id,
      OLD.created_at,OLD.expires_at,OLD.sink_generation,OLD.custody,OLD.erasure_role_version,OLD.erasure_role_xid) THEN
    RAISE EXCEPTION 'Auth recovery Source is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='intent' AND NEW.status='in-flight' AND OLD.attempts=0 AND NEW.attempts=1
    AND OLD.attempted_at IS NULL AND NEW.attempted_at IS NOT NULL
    AND NEW.code='receiving-result-unavailable' THEN
    FOREACH owner_id IN ARRAY ARRAY[NEW.account_id,NEW.erasure_human_id,NEW.erasure_operator_id,
        NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id] LOOP
      PERFORM auth_erasure_admit(owner_id);
      IF EXISTS(SELECT 1 FROM auth_erasure WHERE account_id=owner_id) THEN
        RAISE EXCEPTION 'Auth erasure fence' USING ERRCODE='55000';
      END IF;
    END LOOP;
  ELSIF OLD.status='in-flight' AND NEW.status='unknown' AND NEW.attempts=OLD.attempts
    AND NEW.attempted_at=OLD.attempted_at
    AND NEW.code IN ('legacy-void','unsupported-result','callback-failed','callback-timeout') THEN
    -- Late completion is technical evidence only; current erasure does not
    -- authorize resending, invalidate the source, or certify a receiver fence.
    NULL;
  ELSE
    RAISE EXCEPTION 'Auth recovery Source progress refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_copy_progress BEFORE UPDATE OR DELETE ON auth_recovery_copy_source
  FOR EACH ROW EXECUTE FUNCTION auth_recovery_copy_progress();

ALTER TABLE auth_native_role_deployment DROP CONSTRAINT auth_native_role_deployment_store_index_check;
ALTER TABLE auth_native_role_deployment ADD CHECK(store_index BETWEEN 0 AND 28);
-- A new empty table cannot establish coverage of prior/retired sends. Keep the
-- existing permanent native conversion reason, even after verification TTL.
ALTER TABLE auth_erasure ADD COLUMN recovery_copy_pending text NOT NULL DEFAULT 'recovery-copy-coverage'
  CHECK(recovery_copy_pending IN ('recovery-copy-custody','recovery-copy-coverage'));

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Recovery Source custody is irreversible'; END $$;
