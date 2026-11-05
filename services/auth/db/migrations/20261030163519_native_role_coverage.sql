-- migrate:up
-- The existing copy coverage field remains the sole native completion authority.
-- Drain writers before installing the fence. Queued old leases are refused once
-- the startup cut arms it; deleting an unreconciled row retains unknown custody.
LOCK TABLE "account","auth_attempt_account","auth_barrier_proof","auth_client","auth_client_coverage","auth_client_reduction","auth_client_reduction_progress","auth_consent","auth_effect_receipt","auth_key_assertion","auth_provisioning_receipt","auth_public_key","auth_recent_oidc_session","auth_recovery","auth_recovery_establishment","auth_registration_stage","auth_session_opening","auth_workflow_request","oauthAccessToken","oauthClientAssertion","oauthClientResource","oauthRefreshFamily","oauthRefreshToken","passkey","session","user","verification" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE auth_native_role_deployment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version smallint NOT NULL CHECK(version=1),
  armed boolean NOT NULL DEFAULT false,
  store_index smallint NOT NULL DEFAULT 0 CHECK(store_index BETWEEN 0 AND 27)
);
INSERT INTO auth_native_role_deployment(singleton,version) VALUES(true,1);
UPDATE auth_copy_coverage SET native_covered=false WHERE singleton;
-- Permanent, nonpersonal reasons per source store. Expiry, a missing source
-- or deletion of a historical row never turns unresolved custody into absence.
ALTER TABLE auth_erasure ADD COLUMN native_role_version smallint NOT NULL DEFAULT 0 CHECK(native_role_version IN (0,1));
DROP INDEX auth_erasure_pending;
CREATE INDEX auth_erasure_pending ON auth_erasure(revision,id) WHERE native_completed_at IS NULL OR native_role_version=0;
CREATE TABLE auth_native_role_unknown (
  store text NOT NULL,
  reason text NOT NULL CHECK(reason IN ('historical-role-custody','unsupported-producer-format','source-unavailable')),
  PRIMARY KEY(store,reason)
);
CREATE FUNCTION auth_native_role_unknown(source_store text, reason_code text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth_native_role_unknown(store,reason) VALUES(source_store,reason_code) ON CONFLICT DO NOTHING;
  UPDATE auth_copy_coverage SET native_covered=false WHERE singleton AND native_covered;
$$;

ALTER TABLE "user" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "user" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_user_pending ON "user" ("id") WHERE erasure_role_version=0;
ALTER TABLE "auth_client" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_client" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_auth_client_pending ON "auth_client" ("client_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_session_opening" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_session_opening" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_session_opening" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_session_opening_0 ON "auth_session_opening" (erasure_client_owner_id,"session_id");
ALTER TABLE "auth_session_opening" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_session_opening_1 ON "auth_session_opening" (erasure_source_client_owner_id,"session_id");
CREATE INDEX native_role_auth_session_opening_pending ON "auth_session_opening" ("session_id") WHERE erasure_role_version=0;
ALTER TABLE "session" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "session" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "session" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_session_0 ON "session" (erasure_client_owner_id,"id");
ALTER TABLE "session" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_session_1 ON "session" (erasure_source_client_owner_id,"id");
CREATE INDEX native_role_session_pending ON "session" ("id") WHERE erasure_role_version=0;
ALTER TABLE "verification" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "verification" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "verification" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_verification_0 ON "verification" (erasure_client_owner_id,"id");
ALTER TABLE "verification" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_verification_1 ON "verification" (erasure_source_client_owner_id,"id");
ALTER TABLE verification ADD COLUMN erasure_format text CHECK(erasure_format IN ('reset-v1','webauthn-v1','webauthn-anonymous-v1','code-v1','unknown'));
CREATE INDEX native_role_verification_pending ON "verification" ("id") WHERE erasure_role_version=0;
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_oauthrefreshfamily_0 ON "oauthRefreshFamily" (erasure_client_owner_id,"id");
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_oauthrefreshfamily_1 ON "oauthRefreshFamily" (erasure_source_client_owner_id,"id");
CREATE INDEX native_role_oauthrefreshfamily_pending ON "oauthRefreshFamily" ("id") WHERE erasure_role_version=0;
ALTER TABLE "oauthRefreshToken" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "oauthRefreshToken" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "oauthRefreshToken" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_oauthrefreshtoken_0 ON "oauthRefreshToken" (erasure_client_owner_id,"id");
ALTER TABLE "oauthRefreshToken" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_oauthrefreshtoken_1 ON "oauthRefreshToken" (erasure_source_client_owner_id,"id");
CREATE INDEX native_role_oauthrefreshtoken_pending ON "oauthRefreshToken" ("id") WHERE erasure_role_version=0;
ALTER TABLE "oauthAccessToken" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "oauthAccessToken" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "oauthAccessToken" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_oauthaccesstoken_0 ON "oauthAccessToken" (erasure_client_owner_id,"id");
ALTER TABLE "oauthAccessToken" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_oauthaccesstoken_1 ON "oauthAccessToken" (erasure_source_client_owner_id,"id");
CREATE INDEX native_role_oauthaccesstoken_pending ON "oauthAccessToken" ("id") WHERE erasure_role_version=0;
ALTER TABLE "oauthClientAssertion" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "oauthClientAssertion" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "oauthClientAssertion" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_oauthclientassertion_0 ON "oauthClientAssertion" (erasure_client_owner_id,"id");
ALTER TABLE "oauthClientAssertion" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_oauthclientassertion_1 ON "oauthClientAssertion" (erasure_source_client_owner_id,"id");
CREATE INDEX native_role_oauthclientassertion_pending ON "oauthClientAssertion" ("id") WHERE erasure_role_version=0;
ALTER TABLE "auth_recent_oidc_session" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_recent_oidc_session" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_recent_oidc_session" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_recent_oidc_session_0 ON "auth_recent_oidc_session" (erasure_client_owner_id,"session_id");
ALTER TABLE "auth_recent_oidc_session" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_recent_oidc_session_1 ON "auth_recent_oidc_session" (erasure_source_client_owner_id,"session_id");
CREATE INDEX native_role_auth_recent_oidc_session_pending ON "auth_recent_oidc_session" ("session_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_barrier_proof_0 ON "auth_barrier_proof" (erasure_client_owner_id,"reference");
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_barrier_proof_1 ON "auth_barrier_proof" (erasure_source_client_owner_id,"reference");
CREATE INDEX native_role_auth_barrier_proof_pending ON "auth_barrier_proof" ("reference") WHERE erasure_role_version=0;
ALTER TABLE "auth_recovery_establishment" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_recovery_establishment" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_recovery_establishment" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_recovery_establishment_0 ON "auth_recovery_establishment" (erasure_client_owner_id,"reference");
ALTER TABLE "auth_recovery_establishment" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_recovery_establishment_1 ON "auth_recovery_establishment" (erasure_source_client_owner_id,"reference");
CREATE INDEX native_role_auth_recovery_establishment_pending ON "auth_recovery_establishment" ("reference") WHERE erasure_role_version=0;
ALTER TABLE "auth_registration_stage" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_registration_stage" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_registration_stage" ADD COLUMN erasure_delegate_id text CHECK(octet_length(erasure_delegate_id)<=1024);
CREATE INDEX native_role_auth_registration_stage_0 ON "auth_registration_stage" (erasure_delegate_id,"registration_id");
ALTER TABLE "auth_registration_stage" ADD COLUMN erasure_initiator_id text CHECK(octet_length(erasure_initiator_id)<=1024);
CREATE INDEX native_role_auth_registration_stage_1 ON "auth_registration_stage" (erasure_initiator_id,"registration_id");
ALTER TABLE "auth_registration_stage" ADD COLUMN erasure_actor_version smallint NOT NULL DEFAULT 0 CHECK(erasure_actor_version IN (0,1));
CREATE INDEX native_role_auth_registration_stage_pending ON "auth_registration_stage" ("registration_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_provisioning_receipt" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_provisioning_receipt" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_provisioning_receipt" ADD COLUMN erasure_delegate_id text CHECK(octet_length(erasure_delegate_id)<=1024);
CREATE INDEX native_role_auth_provisioning_receipt_0 ON "auth_provisioning_receipt" (erasure_delegate_id,"idempotency_key");
ALTER TABLE "auth_provisioning_receipt" ADD COLUMN erasure_initiator_id text CHECK(octet_length(erasure_initiator_id)<=1024);
CREATE INDEX native_role_auth_provisioning_receipt_1 ON "auth_provisioning_receipt" (erasure_initiator_id,"idempotency_key");
ALTER TABLE "auth_provisioning_receipt" ADD COLUMN erasure_actor_version smallint NOT NULL DEFAULT 0 CHECK(erasure_actor_version IN (0,1));
CREATE INDEX native_role_auth_provisioning_receipt_pending ON "auth_provisioning_receipt" ("idempotency_key") WHERE erasure_role_version=0;
ALTER TABLE "account" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "account" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_account_pending ON "account" ("id") WHERE erasure_role_version=0;
ALTER TABLE "passkey" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "passkey" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_passkey_pending ON "passkey" ("id") WHERE erasure_role_version=0;
ALTER TABLE "auth_recovery" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_recovery" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_auth_recovery_pending ON "auth_recovery" ("proof_hash") WHERE erasure_role_version=0;
ALTER TABLE "auth_effect_receipt" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_effect_receipt" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_effect_receipt" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_effect_receipt_0 ON "auth_effect_receipt" (erasure_client_owner_id,"receipt_id");
ALTER TABLE "auth_effect_receipt" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_effect_receipt_1 ON "auth_effect_receipt" (erasure_source_client_owner_id,"receipt_id");
CREATE INDEX native_role_auth_effect_receipt_pending ON "auth_effect_receipt" ("receipt_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_workflow_request" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_workflow_request" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_workflow_request" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_workflow_request_0 ON "auth_workflow_request" (erasure_client_owner_id,"workflow_id");
ALTER TABLE "auth_workflow_request" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_workflow_request_1 ON "auth_workflow_request" (erasure_source_client_owner_id,"workflow_id");
ALTER TABLE "auth_workflow_request" ADD COLUMN erasure_delegate_id text CHECK(octet_length(erasure_delegate_id)<=1024);
CREATE INDEX native_role_auth_workflow_request_2 ON "auth_workflow_request" (erasure_delegate_id,"workflow_id");
ALTER TABLE "auth_workflow_request" ADD COLUMN erasure_initiator_id text CHECK(octet_length(erasure_initiator_id)<=1024);
CREATE INDEX native_role_auth_workflow_request_3 ON "auth_workflow_request" (erasure_initiator_id,"workflow_id");
ALTER TABLE "auth_workflow_request" ADD COLUMN erasure_actor_version smallint NOT NULL DEFAULT 0 CHECK(erasure_actor_version IN (0,1));
CREATE INDEX native_role_auth_workflow_request_pending ON "auth_workflow_request" ("workflow_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_public_key" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_public_key" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_auth_public_key_pending ON "auth_public_key" ("account_id","kid") WHERE erasure_role_version=0;
ALTER TABLE "auth_key_assertion" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_key_assertion" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_auth_key_assertion_pending ON "auth_key_assertion" ("account_id","jti") WHERE erasure_role_version=0;
ALTER TABLE "auth_attempt_account" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_attempt_account" ADD COLUMN erasure_role_xid bigint;
CREATE INDEX native_role_auth_attempt_account_pending ON "auth_attempt_account" ("account_id","key") WHERE erasure_role_version=0;
ALTER TABLE "auth_consent" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_consent" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_consent" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_consent_0 ON "auth_consent" (erasure_client_owner_id,"id");
ALTER TABLE "auth_consent" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_consent_1 ON "auth_consent" (erasure_source_client_owner_id,"id");
CREATE INDEX native_role_auth_consent_pending ON "auth_consent" ("account_id","client_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_client_reduction_progress" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_client_reduction_progress" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_client_reduction_progress" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_client_reduction_progress_0 ON "auth_client_reduction_progress" (erasure_client_owner_id,"operation_id");
ALTER TABLE "auth_client_reduction_progress" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_client_reduction_progress_1 ON "auth_client_reduction_progress" (erasure_source_client_owner_id,"operation_id");
CREATE INDEX native_role_auth_client_reduction_progress_pending ON "auth_client_reduction_progress" ("operation_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_client_reduction" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_client_reduction" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_client_reduction" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_client_reduction_0 ON "auth_client_reduction" (erasure_client_owner_id,"client_id");
ALTER TABLE "auth_client_reduction" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_client_reduction_1 ON "auth_client_reduction" (erasure_source_client_owner_id,"client_id");
CREATE INDEX native_role_auth_client_reduction_pending ON "auth_client_reduction" ("client_id") WHERE erasure_role_version=0;
ALTER TABLE "auth_client_coverage" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "auth_client_coverage" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "auth_client_coverage" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_auth_client_coverage_0 ON "auth_client_coverage" (erasure_client_owner_id,"client_id");
ALTER TABLE "auth_client_coverage" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_auth_client_coverage_1 ON "auth_client_coverage" (erasure_source_client_owner_id,"client_id");
CREATE INDEX native_role_auth_client_coverage_pending ON "auth_client_coverage" ("client_id") WHERE erasure_role_version=0;
ALTER TABLE "oauthClientResource" ADD COLUMN erasure_role_version smallint NOT NULL DEFAULT 0 CHECK(erasure_role_version IN (-1,0,1));
ALTER TABLE "oauthClientResource" ADD COLUMN erasure_role_xid bigint;
ALTER TABLE "oauthClientResource" ADD COLUMN erasure_client_owner_id text CHECK(octet_length(erasure_client_owner_id)<=1024);
CREATE INDEX native_role_oauthclientresource_0 ON "oauthClientResource" (erasure_client_owner_id,"id");
ALTER TABLE "oauthClientResource" ADD COLUMN erasure_source_client_owner_id text CHECK(octet_length(erasure_source_client_owner_id)<=1024);
CREATE INDEX native_role_oauthclientresource_1 ON "oauthClientResource" (erasure_source_client_owner_id,"id");
CREATE INDEX native_role_oauthclientresource_pending ON "oauthClientResource" ("id") WHERE erasure_role_version=0;

-- Association refreshes use exact native keys. They preserve committed snapshots
-- when a source later moves or disappears, rather than re-reading today's owner.
CREATE OR REPLACE FUNCTION auth_erasure_admit(owner_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF owner_id IS NULL OR owner_id='' THEN RETURN; END IF;
  -- Only the native bounded deployment page installs this transaction context.
  -- Its trigger accepts version-only updates, never a new artifact or role move.
  IF current_setting('auth.native_role_reconcile',true)='1' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth-erasure:'||owner_id,0));
  IF EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id)
    AND NOT EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id
      AND id::text=current_setting('auth.erasure_obligation',true)) THEN
    RAISE EXCEPTION 'Auth erasure fence' USING ERRCODE='55000';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION auth_erasure_admit_client(client text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner_id text; fenced boolean;
BEGIN
  IF client IS NULL THEN RETURN; END IF;
  IF current_setting('auth.native_role_reconcile',true)='1' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth-client:'||client,0));
  SELECT "userId",erasure_fenced INTO owner_id,fenced FROM auth_client WHERE client_id=client;
  IF EXISTS (SELECT 1 FROM auth_erased_client WHERE client_id=client
      AND obligation_id::text IS DISTINCT FROM current_setting('auth.erasure_obligation',true)) THEN
    RAISE EXCEPTION 'Auth erased client fence' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(owner_id);
  IF fenced AND NOT EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id
      AND id::text=current_setting('auth.erasure_obligation',true)) THEN
    RAISE EXCEPTION 'Auth client erasure fence' USING ERRCODE='55000';
  END IF;
  RETURN;
END $$;
CREATE OR REPLACE FUNCTION auth_erasure_verification_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.erasure_account_id IS NOT NULL AND
     (NEW.erasure_account_id,NEW.erasure_client_id,NEW.erasure_session_id,NEW.erasure_source_client_id) IS DISTINCT FROM
     (OLD.erasure_account_id,OLD.erasure_client_id,OLD.erasure_session_id,OLD.erasure_source_client_id) THEN
    RAISE EXCEPTION 'Auth verification attribution is immutable';
  END IF;
  IF NEW.erasure_session_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.erasure_session_id IS NULL) THEN
    SELECT "clientId",erasure_human_id,erasure_operator_id
      INTO NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
      FROM session WHERE id=NEW.erasure_session_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Auth source session missing' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION auth_native_role_user() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."id") IS DISTINCT FROM ROW(OLD."id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('user',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION auth_native_role_user();

CREATE FUNCTION auth_native_role_auth_client() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_client" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_client();

CREATE FUNCTION auth_native_role_auth_session_opening() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_session_opening','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.subject_account_id IS NOT NULL AND NEW.acting_human_id IS NOT NULL AND NEW.operator_account_id IS NOT NULL;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    SELECT erasure_client_owner_id INTO NEW.erasure_client_owner_id FROM session WHERE id=NEW.session_id AND "userId"=NEW.subject_account_id FOR KEY SHARE; covered:=covered AND FOUND;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_client_owner_id":=COALESCE(OLD."erasure_client_owner_id",NEW."erasure_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."subject_account_id",NEW."acting_human_id",NEW."operator_account_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."subject_account_id",OLD."acting_human_id",OLD."operator_account_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_session_opening',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_session_opening" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_session_opening();

CREATE FUNCTION auth_native_role_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('session','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT acting_human_id,operator_account_id INTO NEW.erasure_human_id,NEW.erasure_operator_id FROM auth_session_opening WHERE session_id=NEW.id AND subject_account_id=NEW."userId";
    covered:=fresh OR FOUND;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId") IS DISTINCT FROM ROW(OLD."userId",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('session',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "session" FOR EACH ROW EXECUTE FUNCTION auth_native_role_session();

CREATE FUNCTION auth_native_role_verification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('verification','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_account_id IS NOT NULL OR (fresh AND NEW.erasure_format='webauthn-anonymous-v1');
    IF NEW.erasure_session_id IS NOT NULL THEN
      SELECT erasure_role_version,erasure_client_owner_id INTO source_version,NEW.erasure_source_client_owner_id FROM session WHERE id=NEW.erasure_session_id AND "userId"=NEW.erasure_account_id FOR KEY SHARE;
      covered:=covered AND FOUND AND source_version=1;
    END IF;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  IF fresh AND TG_OP='INSERT' AND NOT COALESCE(covered,false) THEN NEW.erasure_role_version:=0;
  ELSE NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END; END IF;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."erasure_account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('verification',CASE WHEN fresh THEN CASE WHEN NEW.erasure_format='unknown' THEN 'unsupported-producer-format' ELSE 'source-unavailable' END ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "verification" FOR EACH ROW EXECUTE FUNCTION auth_native_role_verification();

CREATE FUNCTION auth_native_role_oauthrefreshfamily() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthRefreshFamily','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT erasure_account_id,erasure_human_id,erasure_operator_id,erasure_source_client_id,
      erasure_source_client_owner_id,erasure_role_version
      INTO NEW.erasure_account_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_source_client_id,
        NEW.erasure_source_client_owner_id,source_version
      -- Resolve the same newest winner as the pinned native consume. Never
      -- scan older protocol history looking for a matching client.
      FROM (SELECT erasure_account_id,erasure_human_id,erasure_operator_id,erasure_source_client_id,
        erasure_source_client_owner_id,erasure_role_version,erasure_client_id
        FROM verification WHERE identifier=NEW.id
        ORDER BY "createdAt" DESC,id DESC LIMIT 1 FOR KEY SHARE) source
      WHERE source.erasure_client_id=NEW."clientId";
    covered:=FOUND AND source_version=1;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_account_id":=COALESCE(OLD."erasure_account_id",NEW."erasure_account_id");
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."erasure_account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthRefreshFamily',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "oauthRefreshFamily" FOR EACH ROW EXECUTE FUNCTION auth_native_role_oauthrefreshfamily();

CREATE FUNCTION auth_native_role_oauthrefreshtoken() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthRefreshToken','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."sessionId" IS NOT NULL THEN
      SELECT erasure_human_id,erasure_operator_id,"clientId",erasure_client_owner_id,erasure_role_version
        INTO NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_source_client_id,NEW.erasure_source_client_owner_id,source_version
        FROM session WHERE id=NEW."sessionId" AND "userId"=NEW."userId" FOR KEY SHARE;
      covered:=FOUND AND source_version=1;
    ELSE covered:=fresh;
    END IF;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."userId",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthRefreshToken',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION auth_native_role_oauthrefreshtoken();

CREATE FUNCTION auth_native_role_oauthaccesstoken() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthAccessToken','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."sessionId" IS NOT NULL THEN
      SELECT erasure_human_id,erasure_operator_id,"clientId",erasure_client_owner_id,erasure_role_version
        INTO NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_source_client_id,NEW.erasure_source_client_owner_id,source_version
        FROM session WHERE id=NEW."sessionId" AND "userId"=NEW."userId" FOR KEY SHARE;
      covered:=FOUND AND source_version=1;
    ELSE covered:=fresh;
    END IF;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."userId",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthAccessToken',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION auth_native_role_oauthaccesstoken();

CREATE FUNCTION auth_native_role_oauthclientassertion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthClientAssertion','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_client_id IS NOT NULL;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  IF fresh AND TG_OP='INSERT' AND NOT COALESCE(covered,false) THEN NEW.erasure_role_version:=0;
  ELSE NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END; END IF;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthClientAssertion',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "oauthClientAssertion" FOR EACH ROW EXECUTE FUNCTION auth_native_role_oauthclientassertion();

CREATE FUNCTION auth_native_role_auth_recent_oidc_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_recent_oidc_session','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT "clientId",erasure_human_id,erasure_operator_id,erasure_client_owner_id,erasure_role_version INTO NEW.erasure_client_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_owner_id,source_version FROM session WHERE id=NEW.session_id AND "userId"=NEW.account_id FOR KEY SHARE;
    covered:=FOUND AND source_version=1;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_client_id":=COALESCE(OLD."erasure_client_id",NEW."erasure_client_id");
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_client_owner_id":=COALESCE(OLD."erasure_client_owner_id",NEW."erasure_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_recent_oidc_session',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_recent_oidc_session" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_recent_oidc_session();

CREATE FUNCTION auth_native_role_auth_barrier_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_barrier_proof','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW.erasure_session_id IS NOT NULL THEN SELECT erasure_client_owner_id,erasure_role_version INTO NEW.erasure_source_client_owner_id,source_version FROM session WHERE id=NEW.erasure_session_id FOR KEY SHARE; covered:=FOUND AND source_version=1; END IF;
    covered:=covered AND (NEW.purpose<>'consent-reduction' OR NEW.erasure_session_id IS NOT NULL);
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_barrier_proof',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_barrier_proof" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_barrier_proof();

CREATE FUNCTION auth_native_role_auth_recovery_establishment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_recovery_establishment','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT erasure_client_id,erasure_source_client_id,erasure_human_id,erasure_operator_id,erasure_client_owner_id,erasure_source_client_owner_id,erasure_role_version
      INTO NEW.erasure_client_id,NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id,source_version
      FROM auth_barrier_proof WHERE reference=NEW.reference AND account_id=NEW.account_id FOR KEY SHARE;
    covered:=FOUND AND source_version=1;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_client_id":=COALESCE(OLD."erasure_client_id",NEW."erasure_client_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_client_owner_id":=COALESCE(OLD."erasure_client_owner_id",NEW."erasure_client_owner_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_recovery_establishment',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_recovery_establishment" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_recovery_establishment();

CREATE FUNCTION auth_native_role_auth_registration_stage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_registration_stage','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_actor_version=1;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_creator_id",NEW."erasure_operator_id",NEW."erasure_delegate_id",NEW."erasure_initiator_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_creator_id",OLD."erasure_operator_id",OLD."erasure_delegate_id",OLD."erasure_initiator_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_delegate_id);
  PERFORM auth_erasure_admit(NEW.erasure_initiator_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_registration_stage',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_registration_stage" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_registration_stage();

CREATE FUNCTION auth_native_role_auth_provisioning_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_provisioning_receipt','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW.erasure_stage_id IS NOT NULL THEN
      SELECT erasure_delegate_id,erasure_initiator_id,erasure_actor_version,erasure_role_version
        INTO NEW.erasure_delegate_id,NEW.erasure_initiator_id,NEW.erasure_actor_version,source_version
        FROM auth_registration_stage WHERE registration_id=NEW.erasure_stage_id AND account_id=NEW.account_id FOR KEY SHARE;
      covered:=FOUND AND source_version=1;
    ELSE covered:=false;
    END IF;
    covered:=covered AND (NEW.erasure_stage_id IS NULL OR NEW.erasure_actor_version=1);
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_delegate_id":=COALESCE(OLD."erasure_delegate_id",NEW."erasure_delegate_id");
      NEW."erasure_initiator_id":=COALESCE(OLD."erasure_initiator_id",NEW."erasure_initiator_id");
    END IF;
    NEW.erasure_actor_version:=COALESCE(NEW.erasure_actor_version,CASE WHEN TG_OP='UPDATE' THEN OLD.erasure_actor_version ELSE 0 END);
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_creator_id",NEW."erasure_operator_id",NEW."erasure_delegate_id",NEW."erasure_initiator_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_creator_id",OLD."erasure_operator_id",OLD."erasure_delegate_id",OLD."erasure_initiator_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_delegate_id);
  PERFORM auth_erasure_admit(NEW.erasure_initiator_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_provisioning_receipt',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_provisioning_receipt" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_provisioning_receipt();

CREATE FUNCTION auth_native_role_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId") IS DISTINCT FROM ROW(OLD."userId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('account',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "account" FOR EACH ROW EXECUTE FUNCTION auth_native_role_account();

CREATE FUNCTION auth_native_role_passkey() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId") IS DISTINCT FROM ROW(OLD."userId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('passkey',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "passkey" FOR EACH ROW EXECUTE FUNCTION auth_native_role_passkey();

CREATE FUNCTION auth_native_role_auth_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_recovery',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_recovery" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_recovery();

CREATE FUNCTION auth_native_role_auth_effect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_effect_receipt','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=fresh OR NEW.stage_version=1;
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."acting_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."acting_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_effect_receipt',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_effect_receipt" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_effect_receipt();

CREATE FUNCTION auth_native_role_auth_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT (TG_OP='DELETE' AND pg_trigger_depth()>1 AND EXISTS(SELECT 1 FROM auth_copy_work WHERE workflow_id=OLD.workflow_id AND ready AND retired)) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_workflow_request','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_actor_version=1;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_subject_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_member_id",NEW."erasure_previous_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_delegate_id",NEW."erasure_initiator_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."erasure_subject_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_member_id",OLD."erasure_previous_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_delegate_id",OLD."erasure_initiator_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_client_owner_id); END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id); END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_delegate_id); END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_initiator_id); END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_workflow_request',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_workflow_request" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_workflow_request();

CREATE FUNCTION auth_native_role_auth_public_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_public_key',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_public_key" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_public_key();

CREATE FUNCTION auth_native_role_auth_key_assertion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_key_assertion',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_key_assertion" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_key_assertion();

CREATE FUNCTION auth_native_role_auth_attempt_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_attempt_account',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_attempt_account" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_attempt_account();

CREATE FUNCTION auth_native_role_auth_consent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_consent','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_consent',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_consent" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_consent();

CREATE FUNCTION auth_native_role_auth_client_reduction_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_client_reduction_progress','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client_reduction_progress',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_client_reduction_progress" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_client_reduction_progress();

CREATE FUNCTION auth_native_role_auth_client_reduction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_client_reduction','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client_reduction',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_client_reduction" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_client_reduction();

CREATE FUNCTION auth_native_role_auth_client_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_client_coverage','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client_coverage',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "auth_client_coverage" FOR EACH ROW EXECUTE FUNCTION auth_native_role_auth_client_coverage();

CREATE FUNCTION auth_native_role_oauthclientresource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthClientResource','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthClientResource',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_native_role BEFORE INSERT OR UPDATE OR DELETE ON "oauthClientResource" FOR EACH ROW EXECUTE FUNCTION auth_native_role_oauthclientresource();

CREATE FUNCTION auth_native_role_finish_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "verification" SET erasure_role_version=0 WHERE id=NEW.id AND erasure_role_version=0;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zz_native_role_finish AFTER INSERT ON "verification" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION auth_native_role_finish_verification();

CREATE FUNCTION auth_native_role_finish_oauthclientassertion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "oauthClientAssertion" SET erasure_role_version=0 WHERE id=NEW.id AND erasure_role_version=0;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zz_native_role_finish AFTER INSERT ON "oauthClientAssertion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION auth_native_role_finish_oauthclientassertion();

-- migrate:down
-- Forward only: old writers cannot regain custody or erase an unknown source.
