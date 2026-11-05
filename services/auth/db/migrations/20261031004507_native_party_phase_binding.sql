-- migrate:up
-- Forward inventory cut. This marker is a writer fence, never a custody witness.
LOCK TABLE auth_erasure,auth_registration_stage,auth_provisioning_receipt,
  auth_workflow_request IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE auth_native_phase_deployment DROP CONSTRAINT auth_native_phase_deployment_version_check;
UPDATE auth_native_phase_deployment SET version=3 WHERE singleton;
ALTER TABLE auth_native_phase_deployment ADD CONSTRAINT auth_native_phase_deployment_version_check CHECK(version=3);
ALTER TABLE auth_erasure DROP CONSTRAINT auth_erasure_native_phase_version_check;
ALTER TABLE auth_erasure ADD CONSTRAINT auth_erasure_native_phase_version_check CHECK(native_phase_version IN (1,2,3));
ALTER TABLE auth_erasure ALTER COLUMN native_phase_version SET DEFAULT 3;
-- Keep original unavailable-slot progress immutable when its raw boundary is
-- reset. This is progress evidence only, with no new account or source claim.
ALTER TABLE auth_erasure ADD COLUMN native_phase_upgrade jsonb
  CHECK(octet_length(native_phase_upgrade::text)<=16384);
CREATE FUNCTION auth_native_phase_upgrade_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.native_phase_upgrade IS NOT NULL AND NEW.native_phase_upgrade IS DISTINCT FROM OLD.native_phase_upgrade THEN
    RAISE EXCEPTION 'Auth native phase upgrade evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_native_phase_upgrade_immutable BEFORE UPDATE ON auth_erasure
  FOR EACH ROW EXECUTE FUNCTION auth_native_phase_upgrade_immutable();
DROP INDEX auth_erasure_pending;
CREATE INDEX auth_erasure_pending ON auth_erasure(revision,id)
  WHERE native_completed_at IS NULL OR native_role_version=0 OR native_phase_version<3 OR phase<102;

CREATE OR REPLACE FUNCTION auth_native_phase_cursor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NULLIF(current_setting('auth.erasure_obligation',true),'') IS NOT NULL OR
     ROW(NEW.phase,NEW.client_phase,NEW.after_key,NEW.client_id,NEW.native_phase_version,
         NEW.native_completed_at,NEW.native_role_version) IS DISTINCT FROM
     ROW(OLD.phase,OLD.client_phase,OLD.after_key,OLD.client_id,OLD.native_phase_version,
         OLD.native_completed_at,OLD.native_role_version) THEN
    IF current_setting('auth.native_phase_worker',true) IS DISTINCT FROM '3' THEN
      RAISE EXCEPTION 'Auth native phase worker version refused' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.native_phase_version<OLD.native_phase_version THEN
    RAISE EXCEPTION 'Auth native phase downgrade refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION auth_native_phase_producer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- This lock crosses processes and survives a pool restart. The old native
  -- role triggers remain responsible for original source custody and history.
  PERFORM 1 FROM auth_native_phase_deployment WHERE singleton AND version=3 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auth native phase deployment unavailable' USING ERRCODE='55000'; END IF;
  IF NULLIF(current_setting('auth.erasure_obligation',true),'') IS NOT NULL THEN
    IF current_setting('auth.native_phase_worker',true) IS DISTINCT FROM '3' THEN
      RAISE EXCEPTION 'Auth native phase worker version refused' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP<>'DELETE' AND current_setting('auth.native_phase_producer',true) IS DISTINCT FROM '3'
    AND current_setting('auth.native_role_reconcile',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Auth native phase producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION auth_native_phase_coverage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.native_covered AND current_setting('auth.native_phase_producer',true) IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'Auth native phase producer version refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

-- The original request producer supplies every version before serialization.
-- Historical versions remain unknown, never refilled from current relations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_workflow_request WHERE request_party_version=0 LIMIT 1) THEN
    PERFORM auth_native_role_unknown('auth_workflow_request','unsupported-producer-format');
  END IF;
END $$;

CREATE FUNCTION auth_native_request_party_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The original ABI deliberately retains historical version zero. It is not
  -- a current producer claim and can never certify native coverage.
  IF NEW.request_party_version=0 THEN
    PERFORM auth_native_role_unknown('auth_workflow_request','unsupported-producer-format');
  ELSIF NEW.request_context_version<>1 OR NEW.erasure_actor_version<>1 THEN
    RAISE EXCEPTION 'Auth native request party producer version refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzz_native_request_party_version BEFORE INSERT ON auth_workflow_request
  FOR EACH ROW EXECUTE FUNCTION auth_native_request_party_version_guard();

CREATE OR REPLACE FUNCTION auth_erasure_client_empty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM session WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshFamily" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthClientResource" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_consent WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_coverage WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_reduction WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_reduction_progress WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_source_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_registration_stage WHERE erasure_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_registration_stage WHERE erasure_source_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_provisioning_receipt WHERE erasure_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_provisioning_receipt WHERE erasure_source_client_id=OLD.client_id) THEN
    RAISE EXCEPTION 'Auth native client children remain' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;

UPDATE auth_copy_coverage SET native_covered=false WHERE singleton;

-- migrate:down
-- Forward only: saved phase inventories and original boundaries stay distinct.
