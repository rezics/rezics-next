-- migrate:up
-- Native progress is permanent and independent of workflow history. Auth accepts
-- only its trusted deleted/fenced account port, never a kernel connection.
CREATE TABLE auth_erasure (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL UNIQUE,
  barrier integer NOT NULL CHECK (barrier >= 0),
  version integer NOT NULL CHECK (version = 1),
  applicable boolean NOT NULL DEFAULT false,
  inventory_coverage text NOT NULL DEFAULT 'unknown' CHECK (inventory_coverage IN ('unknown','covered')),
  inventory_completed_at timestamptz,
  phase integer NOT NULL DEFAULT 0,
  after_key text NOT NULL DEFAULT '' CHECK (octet_length(after_key) <= 1024),
  client_id text CHECK (octet_length(client_id) <= 1024),
  client_phase integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_deleted_at timestamptz,
  native_completed_at timestamptz,
  consent_due_at timestamptz,
  consent_completed_at timestamptz,
  pending_code text NOT NULL DEFAULT 'native'
);
CREATE INDEX auth_erasure_pending ON auth_erasure (revision,id) WHERE native_completed_at IS NULL;
CREATE TABLE auth_erased_client (
  client_id text PRIMARY KEY,
  obligation_id bigint NOT NULL REFERENCES auth_erasure(id)
);
ALTER TABLE auth_client ADD COLUMN erasure_fenced boolean NOT NULL DEFAULT false;
CREATE TABLE auth_attempt_account (
  account_id text NOT NULL,
  key text NOT NULL,
  PRIMARY KEY (account_id,key)
);
ALTER TABLE auth_consent_erasure ADD COLUMN after_client text NOT NULL DEFAULT '';

-- Native typed provenance: written with the artifact, not discovered by JSON
-- queries during erasure. Nullable columns preserve unknown historical custody.
ALTER TABLE "session" ADD COLUMN erasure_human_id text;
ALTER TABLE "session" ADD COLUMN erasure_operator_id text;
ALTER TABLE "oauthAccessToken" ADD COLUMN erasure_source_client_id text;
CREATE INDEX erasure_oauthaccesstoken_source_client ON "oauthAccessToken" (erasure_source_client_id,id);
ALTER TABLE "oauthAccessToken" ADD COLUMN erasure_human_id text;
ALTER TABLE "oauthAccessToken" ADD COLUMN erasure_operator_id text;
ALTER TABLE "oauthRefreshToken" ADD COLUMN erasure_source_client_id text;
CREATE INDEX erasure_oauthrefreshtoken_source_client ON "oauthRefreshToken" (erasure_source_client_id,id);
ALTER TABLE "oauthRefreshToken" ADD COLUMN erasure_human_id text;
ALTER TABLE "oauthRefreshToken" ADD COLUMN erasure_operator_id text;
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_source_client_id text;
CREATE INDEX erasure_oauthrefreshfamily_source_client ON "oauthRefreshFamily" (erasure_source_client_id,id);
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_account_id text;
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_human_id text;
ALTER TABLE "oauthRefreshFamily" ADD COLUMN erasure_operator_id text;
ALTER TABLE "oauthClientAssertion" ADD COLUMN erasure_client_id text;
ALTER TABLE "verification" ADD COLUMN erasure_source_client_id text;
CREATE INDEX erasure_verification_source_client ON "verification" (erasure_source_client_id,id);
ALTER TABLE "verification" ADD COLUMN erasure_account_id text;
ALTER TABLE "verification" ADD COLUMN erasure_client_id text;
ALTER TABLE "verification" ADD COLUMN erasure_session_id text;
ALTER TABLE "verification" ADD COLUMN erasure_human_id text;
ALTER TABLE "verification" ADD COLUMN erasure_operator_id text;
ALTER TABLE "auth_recent_oidc_session" ADD COLUMN erasure_client_id text;
ALTER TABLE "auth_recent_oidc_session" ADD COLUMN erasure_human_id text;
ALTER TABLE "auth_recent_oidc_session" ADD COLUMN erasure_operator_id text;
ALTER TABLE "auth_session_opening" ADD COLUMN erasure_client_id text;
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_source_client_id text;
CREATE INDEX erasure_auth_barrier_proof_source_client ON "auth_barrier_proof" (erasure_source_client_id,reference);
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_client_id text;
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_session_id text;
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_human_id text;
ALTER TABLE "auth_barrier_proof" ADD COLUMN erasure_operator_id text;
ALTER TABLE "auth_recovery_establishment" ADD COLUMN erasure_source_client_id text;
CREATE INDEX erasure_auth_recovery_establishment_source_client ON "auth_recovery_establishment" (erasure_source_client_id,reference);
ALTER TABLE "auth_recovery_establishment" ADD COLUMN erasure_client_id text;
ALTER TABLE auth_recovery_establishment ADD COLUMN erasure_human_id text;
ALTER TABLE auth_recovery_establishment ADD COLUMN erasure_operator_id text;
CREATE INDEX erasure_establishment_human ON auth_recovery_establishment (erasure_human_id,reference);
CREATE INDEX erasure_establishment_operator ON auth_recovery_establishment (erasure_operator_id,reference);
ALTER TABLE auth_workflow_request ADD COLUMN erasure_subject_id text;
ALTER TABLE auth_workflow_request ADD COLUMN erasure_human_id text;
ALTER TABLE auth_workflow_request ADD COLUMN erasure_operator_id text;
ALTER TABLE auth_workflow_request ADD COLUMN erasure_client_id text;
ALTER TABLE auth_workflow_request ADD COLUMN erasure_member_id text;
ALTER TABLE auth_workflow_request ADD COLUMN erasure_previous_operator_id text;
CREATE INDEX erasure_request_member ON auth_workflow_request (erasure_member_id,workflow_id);
CREATE INDEX erasure_request_previous_operator ON auth_workflow_request (erasure_previous_operator_id,workflow_id);
ALTER TABLE auth_workflow_request ADD COLUMN terminal_at timestamptz;
CREATE INDEX erasure_request_subject ON auth_workflow_request (erasure_subject_id,workflow_id);
CREATE INDEX erasure_request_human ON auth_workflow_request (erasure_human_id,workflow_id);
CREATE INDEX erasure_request_operator ON auth_workflow_request (erasure_operator_id,workflow_id);
CREATE INDEX erasure_request_client ON auth_workflow_request (erasure_client_id,workflow_id);
ALTER TABLE "auth_effect_receipt" ADD COLUMN erasure_operator_id text;
ALTER TABLE auth_registration_stage ADD COLUMN erasure_release_at timestamptz;
ALTER TABLE "auth_registration_stage" ADD COLUMN erasure_creator_id text;
ALTER TABLE "auth_registration_stage" ADD COLUMN erasure_operator_id text;
ALTER TABLE auth_provisioning_receipt ADD COLUMN erasure_creator_id text;
ALTER TABLE auth_provisioning_receipt ADD COLUMN erasure_operator_id text;
ALTER TABLE auth_provisioning_receipt ADD COLUMN erasure_stage_id text;
CREATE INDEX erasure_auth_client_0 ON "auth_client" ("userId","client_id");
CREATE INDEX erasure_account_0 ON "account" ("userId","id");
CREATE INDEX erasure_session_0 ON "session" ("userId","id");
CREATE INDEX erasure_session_1 ON "session" ("clientId","id");
CREATE INDEX erasure_session_2 ON "session" ("erasure_human_id","id");
CREATE INDEX erasure_session_3 ON "session" ("erasure_operator_id","id");
CREATE INDEX erasure_oauthaccesstoken_0 ON "oauthAccessToken" ("userId","id");
CREATE INDEX erasure_oauthaccesstoken_1 ON "oauthAccessToken" ("clientId","id");
CREATE INDEX erasure_oauthaccesstoken_2 ON "oauthAccessToken" ("sessionId","id");
CREATE INDEX erasure_oauthaccesstoken_3 ON "oauthAccessToken" ("refreshId","id");
CREATE INDEX erasure_oauthaccesstoken_4 ON "oauthAccessToken" ("authorizationCodeId","id");
CREATE INDEX erasure_oauthaccesstoken_5 ON "oauthAccessToken" ("erasure_human_id","id");
CREATE INDEX erasure_oauthaccesstoken_6 ON "oauthAccessToken" ("erasure_operator_id","id");
CREATE INDEX erasure_oauthrefreshtoken_0 ON "oauthRefreshToken" ("userId","id");
CREATE INDEX erasure_oauthrefreshtoken_1 ON "oauthRefreshToken" ("clientId","id");
CREATE INDEX erasure_oauthrefreshtoken_2 ON "oauthRefreshToken" ("sessionId","id");
CREATE INDEX erasure_oauthrefreshtoken_3 ON "oauthRefreshToken" ("authorizationCodeId","id");
CREATE INDEX erasure_oauthrefreshtoken_4 ON "oauthRefreshToken" ("erasure_human_id","id");
CREATE INDEX erasure_oauthrefreshtoken_5 ON "oauthRefreshToken" ("erasure_operator_id","id");
CREATE INDEX erasure_oauthrefreshfamily_0 ON "oauthRefreshFamily" ("clientId","id");
CREATE INDEX erasure_oauthrefreshfamily_1 ON "oauthRefreshFamily" ("erasure_account_id","id");
CREATE INDEX erasure_oauthrefreshfamily_2 ON "oauthRefreshFamily" ("erasure_human_id","id");
CREATE INDEX erasure_oauthrefreshfamily_3 ON "oauthRefreshFamily" ("erasure_operator_id","id");
CREATE INDEX erasure_oauthclientassertion_0 ON "oauthClientAssertion" ("erasure_client_id","id");
CREATE INDEX erasure_verification_0 ON "verification" ("erasure_account_id","id");
CREATE INDEX erasure_verification_1 ON "verification" ("erasure_client_id","id");
CREATE INDEX erasure_verification_2 ON "verification" ("erasure_session_id","id");
CREATE INDEX erasure_verification_3 ON "verification" ("erasure_human_id","id");
CREATE INDEX erasure_verification_4 ON "verification" ("erasure_operator_id","id");
CREATE INDEX erasure_auth_recent_oidc_session_0 ON "auth_recent_oidc_session" ("account_id","session_id");
CREATE INDEX erasure_auth_recent_oidc_session_1 ON "auth_recent_oidc_session" ("erasure_client_id","session_id");
CREATE INDEX erasure_auth_recent_oidc_session_2 ON "auth_recent_oidc_session" ("erasure_human_id","session_id");
CREATE INDEX erasure_auth_recent_oidc_session_3 ON "auth_recent_oidc_session" ("erasure_operator_id","session_id");
CREATE INDEX erasure_auth_session_opening_0 ON "auth_session_opening" ("subject_account_id","session_id");
CREATE INDEX erasure_auth_session_opening_1 ON "auth_session_opening" ("acting_human_id","session_id");
CREATE INDEX erasure_auth_session_opening_2 ON "auth_session_opening" ("operator_account_id","session_id");
CREATE INDEX erasure_auth_session_opening_3 ON "auth_session_opening" ("erasure_client_id","session_id");
CREATE INDEX erasure_auth_recovery_establishment_0 ON "auth_recovery_establishment" ("account_id","reference");
CREATE INDEX erasure_auth_recovery_establishment_1 ON "auth_recovery_establishment" ("receipt_id","reference");
CREATE INDEX erasure_auth_recovery_establishment_2 ON "auth_recovery_establishment" ("erasure_client_id","reference");
CREATE INDEX erasure_auth_barrier_proof_0 ON "auth_barrier_proof" ("account_id","reference");
CREATE INDEX erasure_auth_barrier_proof_1 ON "auth_barrier_proof" ("erasure_client_id","reference");
CREATE INDEX erasure_auth_barrier_proof_2 ON "auth_barrier_proof" ("erasure_session_id","reference");
CREATE INDEX erasure_auth_barrier_proof_3 ON "auth_barrier_proof" ("erasure_human_id","reference");
CREATE INDEX erasure_auth_barrier_proof_4 ON "auth_barrier_proof" ("erasure_operator_id","reference");
CREATE INDEX erasure_auth_provisioning_receipt_0 ON "auth_provisioning_receipt" ("account_id","idempotency_key");
CREATE INDEX erasure_auth_provisioning_receipt_1 ON "auth_provisioning_receipt" ("owner_id","idempotency_key");
CREATE INDEX erasure_auth_provisioning_receipt_2 ON "auth_provisioning_receipt" ("credential_id","idempotency_key");
CREATE INDEX erasure_provisioning_creator ON auth_provisioning_receipt (erasure_creator_id,idempotency_key);
CREATE INDEX erasure_provisioning_operator ON auth_provisioning_receipt (erasure_operator_id,idempotency_key);
CREATE INDEX erasure_auth_recovery_0 ON "auth_recovery" ("account_id","proof_hash");
CREATE INDEX erasure_auth_effect_receipt_0 ON "auth_effect_receipt" ("account_id","receipt_id");
CREATE INDEX erasure_auth_effect_receipt_1 ON "auth_effect_receipt" ("acting_human_id","receipt_id");
CREATE INDEX erasure_auth_effect_receipt_2 ON "auth_effect_receipt" ("client_id","receipt_id");
CREATE INDEX erasure_auth_effect_receipt_3 ON "auth_effect_receipt" ("erasure_operator_id","receipt_id");
CREATE INDEX erasure_auth_registration_stage_0 ON "auth_registration_stage" ("account_id","registration_id");
CREATE INDEX erasure_auth_registration_stage_1 ON "auth_registration_stage" ("erasure_creator_id","registration_id");
CREATE INDEX erasure_auth_registration_stage_2 ON "auth_registration_stage" ("erasure_operator_id","registration_id");
CREATE INDEX erasure_auth_client_reduction_progress_0 ON "auth_client_reduction_progress" ("client_id","operation_id");
CREATE INDEX erasure_oauthclientresource_0 ON "oauthClientResource" ("clientId","id");

-- Association hooks run before the fence guards, within the real native write.
CREATE FUNCTION auth_erasure_session_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT acting_human_id,operator_account_id INTO NEW.erasure_human_id,NEW.erasure_operator_id
    FROM auth_session_opening WHERE session_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_attribution BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION auth_erasure_session_roles();
CREATE FUNCTION auth_erasure_opening_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT "clientId" INTO NEW.erasure_client_id FROM session WHERE id=NEW.session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_attribution BEFORE INSERT ON auth_session_opening FOR EACH ROW EXECUTE FUNCTION auth_erasure_opening_roles();
CREATE FUNCTION auth_erasure_opening_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE session SET erasure_human_id=NEW.acting_human_id,erasure_operator_id=NEW.operator_account_id WHERE id=NEW.session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_opening_session AFTER INSERT ON auth_session_opening FOR EACH ROW EXECUTE FUNCTION auth_erasure_opening_session();
CREATE FUNCTION auth_erasure_token_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT "clientId",erasure_human_id,erasure_operator_id
    INTO NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
    FROM session WHERE id=NEW."sessionId" FOR KEY SHARE;
  IF NEW."sessionId" IS NOT NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'Auth source session missing' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_attribution BEFORE INSERT ON "oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION auth_erasure_token_roles();
CREATE TRIGGER erasure_attribution BEFORE INSERT ON "oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION auth_erasure_token_roles();
CREATE FUNCTION auth_erasure_verification_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.erasure_account_id IS NOT NULL AND
     (NEW.erasure_account_id,NEW.erasure_client_id,NEW.erasure_session_id,NEW.erasure_source_client_id) IS DISTINCT FROM
     (OLD.erasure_account_id,OLD.erasure_client_id,OLD.erasure_session_id,OLD.erasure_source_client_id) THEN
    RAISE EXCEPTION 'Auth verification attribution is immutable';
  END IF;
  IF NEW.erasure_session_id IS NOT NULL THEN
    SELECT "clientId",erasure_human_id,erasure_operator_id
      INTO NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
      FROM session WHERE id=NEW.erasure_session_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Auth source session missing' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_attribution BEFORE INSERT OR UPDATE ON verification FOR EACH ROW EXECUTE FUNCTION auth_erasure_verification_roles();
CREATE FUNCTION auth_erasure_recent_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT "clientId",erasure_human_id,erasure_operator_id
    INTO NEW.erasure_client_id,NEW.erasure_human_id,NEW.erasure_operator_id FROM session WHERE id=NEW.session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_attribution BEFORE INSERT ON auth_recent_oidc_session FOR EACH ROW EXECUTE FUNCTION auth_erasure_recent_roles();
CREATE FUNCTION auth_erasure_proof_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose='consent-reduction' AND NEW.evidence->>0='consent-v1' THEN
    NEW.erasure_session_id:=NEW.evidence->>3;
    NEW.erasure_client_id:=NEW.evidence->>8;
    NEW.erasure_source_client_id:=NEW.evidence->>4;
    SELECT erasure_human_id,erasure_operator_id INTO NEW.erasure_human_id,NEW.erasure_operator_id
      FROM session WHERE id=NEW.erasure_session_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_attribution BEFORE INSERT ON auth_barrier_proof FOR EACH ROW EXECUTE FUNCTION auth_erasure_proof_roles();
CREATE FUNCTION auth_erasure_establishment_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT erasure_client_id,erasure_source_client_id,erasure_human_id,erasure_operator_id
    INTO NEW.erasure_client_id,NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
    FROM auth_barrier_proof WHERE reference=NEW.reference;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_attribution BEFORE INSERT ON auth_recovery_establishment FOR EACH ROW EXECUTE FUNCTION auth_erasure_establishment_roles();

-- Producers share an account fence with obligation acceptance. No mutable native
-- row or old workflow can recreate data after that transaction commits.
CREATE FUNCTION auth_erasure_admit(owner_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF owner_id IS NULL OR owner_id='' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth-erasure:'||owner_id,0));
  IF EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id)
    AND NOT EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id
      AND id::text=current_setting('auth.erasure_obligation',true)) THEN
    RAISE EXCEPTION 'Auth erasure fence' USING ERRCODE='55000';
  END IF;
END $$;
CREATE FUNCTION auth_erasure_admit_client(client text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner_id text; fenced boolean;
BEGIN
  IF client IS NULL THEN RETURN; END IF;
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
END $$;
CREATE FUNCTION auth_erasure_guard_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."id");
  END IF;
  PERFORM auth_erasure_admit(NEW."id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_user();
CREATE FUNCTION auth_erasure_guard_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "account" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_account();
CREATE FUNCTION auth_erasure_guard_passkey() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "passkey" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_passkey();
CREATE FUNCTION auth_erasure_guard_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "session" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_session();
CREATE FUNCTION auth_erasure_guard_oauthaccesstoken() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_oauthaccesstoken();
CREATE FUNCTION auth_erasure_guard_oauthrefreshtoken() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_oauthrefreshtoken();
CREATE FUNCTION auth_erasure_guard_oauthrefreshfamily() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."erasure_account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."erasure_account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "oauthRefreshFamily" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_oauthrefreshfamily();
CREATE FUNCTION auth_erasure_guard_auth_client() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit_client(OLD.client_id);
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit_client(NEW.client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_client" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_client();
CREATE FUNCTION auth_erasure_guard_auth_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_consent" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_consent();
CREATE FUNCTION auth_erasure_guard_auth_public_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_public_key" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_public_key();
CREATE FUNCTION auth_erasure_guard_auth_key_assertion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_key_assertion" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_key_assertion();
CREATE FUNCTION auth_erasure_guard_auth_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_recovery" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_recovery();
CREATE FUNCTION auth_erasure_guard_auth_barrier_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_barrier_proof" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_barrier_proof();
CREATE FUNCTION auth_erasure_guard_auth_recovery_establishment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD.erasure_human_id);
  PERFORM auth_erasure_admit(OLD.erasure_operator_id);
  PERFORM auth_erasure_admit_client(OLD.erasure_client_id);
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW.erasure_human_id);
  PERFORM auth_erasure_admit(NEW.erasure_operator_id);
  PERFORM auth_erasure_admit_client(NEW.erasure_client_id);
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_recovery_establishment" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_recovery_establishment();
CREATE FUNCTION auth_erasure_guard_auth_session_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."subject_account_id");
  PERFORM auth_erasure_admit(OLD."acting_human_id");
  PERFORM auth_erasure_admit(OLD."operator_account_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."subject_account_id");
  PERFORM auth_erasure_admit(NEW."acting_human_id");
  PERFORM auth_erasure_admit(NEW."operator_account_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_session_opening" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_session_opening();
CREATE FUNCTION auth_erasure_guard_auth_effect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."acting_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."acting_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_effect_receipt" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_effect_receipt();
CREATE FUNCTION auth_erasure_guard_auth_provisioning_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- The stage's unique native account binding establishes these roles in the
    -- credential/receipt transaction. No encrypted payload or request JSON walk.
    SELECT registration_id,erasure_creator_id,erasure_operator_id
    INTO NEW.erasure_stage_id,NEW.erasure_creator_id,NEW.erasure_operator_id
    FROM auth_registration_stage WHERE account_id=NEW.account_id;
  END IF;
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD.erasure_creator_id);
  PERFORM auth_erasure_admit(OLD.erasure_operator_id);
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW.erasure_creator_id);
  PERFORM auth_erasure_admit(NEW.erasure_operator_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_provisioning_receipt" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_provisioning_receipt();
CREATE FUNCTION auth_erasure_guard_auth_registration_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.erasure_release_at IS NOT NULL
    AND (to_jsonb(NEW)-'erasure_release_at')=(to_jsonb(OLD)-'erasure_release_at') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."erasure_creator_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."erasure_creator_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_registration_stage" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_registration_stage();
CREATE FUNCTION auth_erasure_guard_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."erasure_account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."erasure_account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "verification" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_verification();
CREATE FUNCTION auth_erasure_guard_auth_attempt_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_attempt_account" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_attempt_account();
CREATE FUNCTION auth_erasure_guard_auth_recent_oidc_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_recent_oidc_session" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_recent_oidc_session();
CREATE FUNCTION auth_erasure_guard_oauthclientassertion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "oauthClientAssertion" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_oauthclientassertion();
CREATE FUNCTION auth_erasure_guard_auth_client_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_client_coverage" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_client_coverage();
CREATE FUNCTION auth_erasure_guard_auth_client_reduction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_client_reduction" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_client_reduction();
CREATE FUNCTION auth_erasure_guard_auth_client_reduction_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "auth_client_reduction_progress" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_auth_client_reduction_progress();
CREATE FUNCTION auth_erasure_guard_oauthclientresource() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."clientId");
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON "oauthClientResource" FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_oauthclientresource();

-- Child absence is checked in native stores as well as in progress. These
-- functions never authorize a cascade through a missed/legacy attribution.
CREATE FUNCTION auth_erasure_user_empty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM session WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM passkey WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_client WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_public_key WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_key_assertion WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_recovery WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_barrier_proof WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_session_opening WHERE subject_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_provisioning_receipt WHERE owner_id=OLD.id) THEN
    RAISE EXCEPTION 'Auth native user children remain' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER erasure_zero_children BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION auth_erasure_user_empty();
CREATE FUNCTION auth_erasure_client_empty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM session WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshFamily" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthClientResource" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_consent WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_coverage WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_reduction WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_reduction_progress WHERE client_id=OLD.client_id) THEN
    RAISE EXCEPTION 'Auth native client children remain' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER erasure_zero_children BEFORE DELETE ON auth_client FOR EACH ROW EXECUTE FUNCTION auth_erasure_client_empty();


-- Request rows remain while their native release consumer can still run. The
-- supported workflow result marks terminal state; history loss is not a proof.
CREATE FUNCTION auth_erasure_guard_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.request IS NOT DISTINCT FROM OLD.request
     AND NEW.digest IS NOT DISTINCT FROM OLD.digest
     AND (NEW.erasure_subject_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_id,NEW.erasure_member_id,NEW.erasure_previous_operator_id)
       IS NOT DISTINCT FROM (OLD.erasure_subject_id,OLD.erasure_human_id,OLD.erasure_operator_id,OLD.erasure_client_id,OLD.erasure_member_id,OLD.erasure_previous_operator_id)
     AND NEW.terminal_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    PERFORM auth_erasure_admit(OLD.erasure_member_id);
    PERFORM auth_erasure_admit(OLD.erasure_previous_operator_id);
    PERFORM auth_erasure_admit(OLD.erasure_subject_id);
    PERFORM auth_erasure_admit(OLD.erasure_human_id);
    PERFORM auth_erasure_admit(OLD.erasure_operator_id);
    PERFORM auth_erasure_admit_client(OLD.erasure_client_id);
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_member_id);
  PERFORM auth_erasure_admit(NEW.erasure_previous_operator_id);
  PERFORM auth_erasure_admit(NEW.erasure_subject_id);
  PERFORM auth_erasure_admit(NEW.erasure_human_id);
  PERFORM auth_erasure_admit(NEW.erasure_operator_id);
  PERFORM auth_erasure_admit_client(NEW.erasure_client_id);
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON auth_workflow_request
 FOR EACH ROW EXECUTE FUNCTION auth_erasure_guard_request();

-- migrate:down
-- Forward only: a deleted account cannot regain native producer authority.
