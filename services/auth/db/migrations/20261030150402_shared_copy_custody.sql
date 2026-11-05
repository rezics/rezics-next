-- migrate:up
-- Auth owns these tables and its isolated auth_dbos database/schema. SDK tables
-- are never rewritten; host-installed triggers record copy creation atomically.
CREATE TABLE auth_copy_coverage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version=1),
  covered boolean NOT NULL DEFAULT false,
  native_covered boolean NOT NULL DEFAULT false
);
INSERT INTO auth_copy_coverage(singleton,version) VALUES(true,1);
-- Historical rows without a complete typed creation cut remain unknown.
UPDATE auth_copy_coverage SET native_covered=
  NOT EXISTS(SELECT 1 FROM "oauthAccessToken" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "verification" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_recent_oidc_session" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "oauthClientAssertion" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "oauthRefreshToken" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "oauthRefreshFamily" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "session" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_session_opening" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_recovery_establishment" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_barrier_proof" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_provisioning_receipt" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "account" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_effect_receipt" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_registration_stage" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_recovery" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "user" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_client" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_consent" LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM "auth_workflow_request" LIMIT 1);
CREATE TABLE auth_copy_work (
  workflow_id text PRIMARY KEY CHECK (octet_length(workflow_id)<=256),
  name text NOT NULL CHECK (name IN ('accounts.registration','accounts.operation','accounts.client-reduction')),
  digest bytea NOT NULL CHECK (octet_length(digest)=32),
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  scope_count integer NOT NULL CHECK(scope_count BETWEEN 1 AND 16),
  ready boolean NOT NULL DEFAULT false,
  retired boolean NOT NULL DEFAULT false,
  absent boolean NOT NULL DEFAULT false,
  rows integer NOT NULL DEFAULT 0 CHECK(rows BETWEEN 0 AND 139),
  bytes integer NOT NULL DEFAULT 0 CHECK(bytes BETWEEN 0 AND 10485760),
  CHECK (NOT absent OR retired)
);
ALTER TABLE auth_copy_work ADD COLUMN parent_workflow_id text REFERENCES auth_copy_work(workflow_id);
CREATE TABLE auth_copy_role (
  account_id text NOT NULL CHECK (octet_length(account_id)<=128),
  workflow_id text NOT NULL REFERENCES auth_copy_work(workflow_id),
  role text NOT NULL CHECK(role IN ('subject','human','operator','member','previous-operator','initiator','delegate','client-owner')),
  PRIMARY KEY(account_id,workflow_id,role)
);
CREATE INDEX auth_copy_role_work ON auth_copy_role(workflow_id,account_id,role);
CREATE TABLE auth_copy_artifact (
  workflow_id text NOT NULL REFERENCES auth_copy_work(workflow_id),
  kind text NOT NULL CHECK(kind IN ('workflow_status','workflow_input','workflow_output','operation_outputs','workflow_events','workflow_events_history','notifications')),
  key text NOT NULL CHECK(octet_length(key)<=384),
  bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 65536),
  PRIMARY KEY(workflow_id,kind,key)
);
ALTER TABLE auth_client_reduction_progress ADD COLUMN current_workflow_id text CHECK(octet_length(current_workflow_id)<=256);
ALTER TABLE auth_erasure ADD COLUMN kernel_version integer;
ALTER TABLE auth_erasure ADD COLUMN kernel_at text CHECK(octet_length(kernel_at)<=64);
ALTER TABLE auth_erasure ADD COLUMN source_continuation_id uuid;
ALTER TABLE auth_erasure ADD COLUMN source_receipt_id uuid;
ALTER TABLE auth_erasure ADD COLUMN source_workflow_id text CHECK(octet_length(source_workflow_id)<=256);
ALTER TABLE auth_erasure ADD COLUMN source_accepted_at timestamptz;
ALTER TABLE auth_erasure ADD COLUMN source_discharged_at timestamptz;
ALTER TABLE auth_erasure ADD COLUMN source_published_at timestamptz;
ALTER TABLE auth_erasure ADD COLUMN copies_completed_at timestamptz;
ALTER TABLE auth_erasure ADD COLUMN copies_published_at timestamptz;
ALTER TABLE auth_erasure ADD CONSTRAINT auth_erasure_kernel_identity CHECK((kernel_version IS NULL AND kernel_at IS NULL) OR (kernel_version>0 AND kernel_at IS NOT NULL));
ALTER TABLE auth_erasure ADD CONSTRAINT auth_erasure_source CHECK((source_continuation_id IS NULL AND source_receipt_id IS NULL AND source_accepted_at IS NULL AND source_discharged_at IS NULL AND source_published_at IS NULL) OR (kernel_at IS NOT NULL AND source_continuation_id IS NOT NULL AND source_receipt_id IS NOT NULL AND source_accepted_at IS NOT NULL AND (source_published_at IS NULL OR source_discharged_at IS NOT NULL)));
CREATE INDEX auth_erasure_copy_pending ON auth_erasure(revision,id) WHERE copies_published_at IS NULL;
CREATE FUNCTION auth_copy_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM auth_copy_work WHERE workflow_id=OLD.workflow_id AND retired AND absent) THEN
    RAISE EXCEPTION 'Auth copy role custody is immutable' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER auth_copy_role_guard BEFORE DELETE OR UPDATE ON auth_copy_role FOR EACH ROW EXECUTE FUNCTION auth_copy_role_guard();
CREATE FUNCTION auth_copy_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE work text; locator text; size integer; old_size integer; existed boolean; current_work auth_copy_work; cap integer;
BEGIN
  IF TG_TABLE_NAME='notifications' THEN
    work:=NEW.destination_uuid; locator:=NEW.message_uuid;
  ELSE
    work:=NEW.workflow_uuid;
    IF TG_TABLE_NAME='operation_outputs' THEN locator:=NEW.function_id::text;
    ELSIF TG_TABLE_NAME='workflow_events' THEN locator:=NEW.key;
    ELSIF TG_TABLE_NAME='workflow_events_history' THEN locator:=NEW.function_id::text||':'||NEW.key;
    ELSIF TG_TABLE_NAME='streams' THEN RAISE EXCEPTION 'Auth stream copy is undeclared' USING ERRCODE='55000';
    ELSE locator:=''; END IF;
  END IF;
  SELECT * INTO current_work FROM auth_copy_work WHERE workflow_id=work FOR UPDATE;
  IF NOT FOUND THEN
    -- The two maintenance workflows have a closed counts-only contract. Every
    -- personal workflow (including a child) must already have complete scope.
    IF TG_TABLE_NAME='workflow_status' THEN
      IF NEW.name IN ('auth.maintenance.tick','auth.workflowRetention') THEN RETURN NEW; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM auth_dbos.workflow_status WHERE workflow_uuid=work AND name IN ('auth.maintenance.tick','auth.workflowRetention')) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Auth copy custody missing' USING ERRCODE='55000';
  END IF;
  IF current_work.retired THEN
    IF TG_OP='UPDATE' AND TG_TABLE_NAME='workflow_status' THEN
      IF NEW.status='CANCELLED' AND NEW.owner_xid IS NULL AND
        (to_jsonb(NEW)-ARRAY['status','owner_xid','queue_name','deduplication_id','started_at_epoch_ms','updated_at','completed_at']) =
        (to_jsonb(OLD)-ARRAY['status','owner_xid','queue_name','deduplication_id','started_at_epoch_ms','updated_at','completed_at']) THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Auth copy work retired' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM auth_copy_role WHERE workflow_id=work)<>current_work.scope_count THEN
    RAISE EXCEPTION 'Auth copy role coverage missing' USING ERRCODE='55000';
  END IF;
  size:=octet_length(row_to_json(NEW)::text);
  IF size>(CASE WHEN TG_TABLE_NAME='workflow_status' THEN 4096 ELSE 65536 END) THEN
    RAISE EXCEPTION 'Auth copy byte cap' USING ERRCODE='54000';
  END IF;
  IF TG_TABLE_NAME='streams' THEN RAISE EXCEPTION 'Auth stream copy is undeclared' USING ERRCODE='55000'; END IF;
  SELECT true,bytes INTO existed,old_size FROM auth_copy_artifact WHERE workflow_id=work AND kind=TG_TABLE_NAME AND key=locator;
  IF existed IS DISTINCT FROM true THEN
    cap:=CASE TG_TABLE_NAME WHEN 'operation_outputs' THEN 60 WHEN 'workflow_events' THEN 8 WHEN 'workflow_events_history' THEN 64 WHEN 'notifications' THEN 4 ELSE 1 END;
    IF (SELECT count(*) FROM auth_copy_artifact WHERE workflow_id=work AND kind=TG_TABLE_NAME)>=cap THEN
      RAISE EXCEPTION 'Auth copy row cap' USING ERRCODE='54000';
    END IF;
    UPDATE auth_copy_work SET rows=rows+1,bytes=bytes+size WHERE workflow_id=work;
  END IF;
  IF existed AND size>old_size THEN UPDATE auth_copy_work SET bytes=bytes+size-old_size WHERE workflow_id=work; END IF;
  INSERT INTO auth_copy_artifact(workflow_id,kind,key,bytes) VALUES(work,TG_TABLE_NAME,locator,size)
    ON CONFLICT(workflow_id,kind,key) DO UPDATE SET bytes=GREATEST(auth_copy_artifact.bytes,EXCLUDED.bytes);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION auth_delete_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.auth_workflow_request WHERE workflow_id=OLD.workflow_uuid AND terminal_at IS NOT NULL;
  RETURN OLD;
END $$;
CREATE FUNCTION auth_erasure_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.barrier IS DISTINCT FROM OLD.barrier
    OR (OLD.kernel_at IS NOT NULL AND (NEW.kernel_at IS DISTINCT FROM OLD.kernel_at OR NEW.kernel_version IS DISTINCT FROM OLD.kernel_version))
    OR (OLD.source_accepted_at IS NOT NULL AND (NEW.source_continuation_id IS DISTINCT FROM OLD.source_continuation_id OR NEW.source_receipt_id IS DISTINCT FROM OLD.source_receipt_id OR NEW.source_accepted_at IS DISTINCT FROM OLD.source_accepted_at OR NEW.source_workflow_id IS DISTINCT FROM OLD.source_workflow_id))
    OR (OLD.source_discharged_at IS NOT NULL AND NEW.source_discharged_at IS DISTINCT FROM OLD.source_discharged_at)
    OR (OLD.copies_completed_at IS NOT NULL AND NEW.copies_completed_at IS DISTINCT FROM OLD.copies_completed_at) THEN
    RAISE EXCEPTION 'Auth erasure proof is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_erasure_proof_immutable BEFORE UPDATE OR DELETE ON auth_erasure FOR EACH ROW EXECUTE FUNCTION auth_erasure_proof_immutable();

-- migrate:down
-- Forward only: retired work and immutable barriers cannot be reopened.
