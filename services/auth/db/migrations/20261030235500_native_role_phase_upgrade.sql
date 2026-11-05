-- migrate:up
-- A version cut, not coverage evidence. Drain the native writers before the
-- permanent guard starts refusing queued old leases and old erasure pages.
LOCK TABLE auth_erasure,auth_registration_stage,auth_provisioning_receipt,auth_workflow_request IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE auth_native_phase_deployment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version smallint NOT NULL CHECK(version=2)
);
INSERT INTO auth_native_phase_deployment(singleton,version) VALUES(true,2);
ALTER TABLE auth_erasure ADD COLUMN native_phase_version smallint NOT NULL DEFAULT 1 CHECK(native_phase_version IN (1,2));
DROP INDEX auth_erasure_pending;
CREATE INDEX auth_erasure_pending ON auth_erasure(revision,id)
  WHERE native_completed_at IS NULL OR native_role_version=0 OR native_phase_version<2 OR phase<90;

CREATE FUNCTION auth_native_phase_cursor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NULLIF(current_setting('auth.erasure_obligation',true),'') IS NOT NULL OR
     ROW(NEW.phase,NEW.client_phase,NEW.after_key,NEW.client_id,NEW.native_phase_version,
         NEW.native_completed_at,NEW.native_role_version) IS DISTINCT FROM
     ROW(OLD.phase,OLD.client_phase,OLD.after_key,OLD.client_id,OLD.native_phase_version,
         OLD.native_completed_at,OLD.native_role_version) THEN
    IF current_setting('auth.native_phase_worker',true) IS DISTINCT FROM '2' THEN
      RAISE EXCEPTION 'Auth native phase worker version refused' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.native_phase_version<OLD.native_phase_version THEN
    RAISE EXCEPTION 'Auth native phase downgrade refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_native_phase_cursor_guard BEFORE INSERT OR UPDATE ON auth_erasure
  FOR EACH ROW EXECUTE FUNCTION auth_native_phase_cursor_guard();

CREATE FUNCTION auth_native_phase_producer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- This lock crosses processes and survives a pool restart. The old native
  -- role triggers remain responsible for original source custody and history.
  PERFORM 1 FROM auth_native_phase_deployment WHERE singleton AND version=2 FOR SHARE;
  IF NULLIF(current_setting('auth.erasure_obligation',true),'') IS NOT NULL THEN
    IF current_setting('auth.native_phase_worker',true) IS DISTINCT FROM '2' THEN
      RAISE EXCEPTION 'Auth native phase worker version refused' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP<>'DELETE' AND current_setting('auth.native_phase_producer',true) IS DISTINCT FROM '2'
    AND current_setting('auth.native_role_reconcile',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Auth native phase producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_native_phase_producer_guard BEFORE INSERT OR UPDATE OR DELETE ON auth_registration_stage
  FOR EACH ROW EXECUTE FUNCTION auth_native_phase_producer_guard();
CREATE TRIGGER auth_native_phase_producer_guard BEFORE INSERT OR UPDATE OR DELETE ON auth_provisioning_receipt
  FOR EACH ROW EXECUTE FUNCTION auth_native_phase_producer_guard();
CREATE TRIGGER auth_native_phase_producer_guard BEFORE INSERT OR UPDATE OR DELETE ON auth_workflow_request
  FOR EACH ROW EXECUTE FUNCTION auth_native_phase_producer_guard();

-- Old proof publishers read this existing authority, not the new phase marker.
-- Invalidate their carried deployment EOF atomically with activation. A queued
-- old reconciliation page cannot restore it after this cut.
UPDATE auth_copy_coverage SET native_covered=false WHERE singleton;
CREATE FUNCTION auth_native_phase_coverage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.native_covered AND current_setting('auth.native_phase_producer',true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'Auth native phase producer version refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_native_phase_coverage_guard BEFORE INSERT OR UPDATE ON auth_copy_coverage
  FOR EACH ROW EXECUTE FUNCTION auth_native_phase_coverage_guard();

-- migrate:down
-- Forward only: saved phase meaning and the producer cut cannot be forgotten.
