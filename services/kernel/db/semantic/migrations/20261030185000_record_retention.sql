-- migrate:up
-- Native ordinary contribution lifecycle. A tombstone is independent of editorial selection/moderation.
CREATE TABLE semantic.record_lifecycle (
 route integer NOT NULL, subject_id uuid NOT NULL, candidate_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('active','deleted','purging','purged')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 deletion_generation uuid NOT NULL, deletion_transaction_id uuid NOT NULL,
 deleted_at timestamptz NOT NULL, purge_after timestamptz NOT NULL,
 held boolean NOT NULL DEFAULT false,
 PRIMARY KEY(route,subject_id,candidate_id),
 FOREIGN KEY(route,subject_id,candidate_id) REFERENCES semantic.candidate(route,subject_id,candidate_id),
 CHECK(route=((get_byte(uuid_send(subject_id),10)*256)+get_byte(uuid_send(subject_id),11))),
 CHECK(route=((get_byte(uuid_send(candidate_id),10)*256)+get_byte(uuid_send(candidate_id),11))),
 CHECK(purge_after=deleted_at+interval '720 hours')
);
CREATE TABLE semantic.record_retention_commit (
 route integer NOT NULL, subject_id uuid NOT NULL, candidate_id uuid NOT NULL, deletion_generation uuid NOT NULL,
 transaction_id uuid NOT NULL, epoch integer NOT NULL, position bigint NOT NULL,
 deleted_at timestamptz NOT NULL, purge_after timestamptz NOT NULL,
 PRIMARY KEY(route,subject_id,candidate_id,deletion_generation)
);
CREATE TABLE semantic.record_retention_document (
 route integer NOT NULL, subject_id uuid NOT NULL, candidate_id uuid NOT NULL,
 deletion_generation uuid NOT NULL, document_id uuid NOT NULL,
 minimized boolean NOT NULL DEFAULT false,
 PRIMARY KEY(route,subject_id,candidate_id,deletion_generation,document_id),
 FOREIGN KEY(route,subject_id,candidate_id) REFERENCES semantic.record_lifecycle(route,subject_id,candidate_id)
);
-- A bounded rotating work index, never lifecycle/permission or shared-copy completion authority.
CREATE TABLE semantic.record_retention_key (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 key bigint GENERATED ALWAYS AS IDENTITY,
 route integer NOT NULL, kind text NOT NULL CHECK(kind IN ('candidate','context','zone')),
 owner_id uuid NOT NULL, record_id uuid NOT NULL,
 generation uuid NOT NULL DEFAULT gen_random_uuid(), deleted_at timestamptz NOT NULL,
 phase text NOT NULL DEFAULT 'local' CHECK(phase IN ('local','shared','complete')),
 fragment_store integer NOT NULL DEFAULT 0 CHECK(fragment_store BETWEEN 0 AND 9),
 fragment_key bigint NOT NULL DEFAULT 0 CHECK(fragment_key>=0),
 PRIMARY KEY(partition_no,key), UNIQUE(route,kind,owner_id,record_id), CHECK(route/16=partition_no)
);
CREATE INDEX record_retention_pending ON semantic.record_retention_key(partition_no,key) WHERE phase<>'complete';
CREATE TABLE semantic.record_retention_home (
 partition_no integer PRIMARY KEY CHECK(partition_no BETWEEN 0 AND 4095), after_key bigint NOT NULL DEFAULT 0
);
CREATE TABLE semantic.record_retention_schedule (
 partition_no integer PRIMARY KEY CHECK(partition_no=0), after_home integer NOT NULL DEFAULT -1
);
INSERT INTO semantic.record_retention_schedule(partition_no) VALUES(0);
CREATE TABLE semantic.record_retention_page (
 partition_no integer NOT NULL, key text NOT NULL CHECK(octet_length(key) BETWEEN 1 AND 255),
 input_limit integer NOT NULL CHECK(input_limit BETWEEN 1 AND 100), result jsonb NOT NULL,
 PRIMARY KEY(partition_no,key)
);
CREATE FUNCTION semantic.capture_record_retention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; owner_id uuid; record_id uuid; at timestamptz; deleted boolean; restarted boolean;
BEGIN
 IF TG_TABLE_NAME='record_lifecycle' THEN
  kind:='candidate';owner_id:=NEW.subject_id;record_id:=NEW.candidate_id;
  at:=NEW.deleted_at;deleted:=NEW.state IN ('deleted','purging');
 ELSIF TG_TABLE_NAME='context' THEN
  kind:='context';owner_id:=NEW.context_id;record_id:=NEW.context_id;
  at:=NEW.deleted_at;deleted:=NEW.state='deleted';
 ELSE
  kind:='zone';owner_id:=NEW.zone_id;record_id:=NEW.zone_id;
  at:=NEW.deleted_at;deleted:=NEW.state='deleted';
 END IF;
 restarted:=TG_OP='INSERT';
 IF TG_OP='UPDATE' THEN restarted:=NEW.state='deleted' AND OLD.state='active'; END IF;
 IF deleted THEN
  INSERT INTO semantic.record_retention_home(partition_no) VALUES(NEW.route/16) ON CONFLICT DO NOTHING;
  INSERT INTO semantic.record_retention_key(partition_no,route,kind,owner_id,record_id,deleted_at)
   VALUES(NEW.route/16,NEW.route,kind,owner_id,record_id,at)
   ON CONFLICT(route,kind,owner_id,record_id) DO UPDATE SET
    generation=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN gen_random_uuid() ELSE record_retention_key.generation END,
    phase=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 'local' ELSE record_retention_key.phase END,
    fragment_store=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 0 ELSE record_retention_key.fragment_store END,
    fragment_key=CASE WHEN restarted OR record_retention_key.deleted_at<>EXCLUDED.deleted_at THEN 0 ELSE record_retention_key.fragment_key END,
    deleted_at=EXCLUDED.deleted_at;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_lifecycle_retention AFTER INSERT OR UPDATE ON semantic.record_lifecycle
 FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_retention();
CREATE TRIGGER context_record_retention AFTER INSERT OR UPDATE OF state,deleted_at ON semantic.context
 FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_retention();
-- Prefixes bound fragments independently of unrelated history, before any payload filtering.
CREATE INDEX record_retention_fact ON semantic.fact(route,subject_id,statement_id,erasure_key);
CREATE INDEX record_retention_moderation ON semantic.moderation(route,subject_id,candidate_id,erasure_key);
CREATE INDEX record_retention_retraction ON semantic.retraction(route,subject_id,candidate_id,erasure_key);
CREATE INDEX record_retention_source ON semantic.source_candidate(route,subject_id,candidate_id,erasure_key);
CREATE INDEX record_retention_extension ON semantic.context_extension(route,context_id,erasure_key);
CREATE INDEX record_retention_activation ON semantic.context_extension_activation(route,context_id,erasure_key);
CREATE INDEX record_retention_composite ON semantic.release_composite(extension_route,extension_context_id,erasure_key);

-- This narrow guard lends exactly one native payload row to the existing owner minimizers. It never
-- authorizes identity/decision changes, Content/Core writes, an account-T or a shared custody ACK.
CREATE FUNCTION semantic.record_retention_mutation_allowed(p_store text,p_route integer,p_key bigint)
 RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE work semantic.record_retention_key; valid boolean;
BEGIN
 IF current_setting('semantic.record_retention_store',true) IS DISTINCT FROM p_store OR
    nullif(current_setting('semantic.record_retention_fragment',true),'')::bigint IS DISTINCT FROM p_key THEN RETURN false; END IF;
 SELECT * INTO work FROM semantic.record_retention_key WHERE partition_no=p_route/16
  AND key=nullif(current_setting('semantic.record_retention_key',true),'')::bigint AND phase='local' AND route=p_route;
 IF NOT FOUND THEN RETURN false; END IF;
 IF work.kind='candidate' THEN
  SELECT l.state IN ('deleted','purging') AND NOT l.held AND l.deleted_at=work.deleted_at
   AND l.purge_after<=nullif(current_setting('semantic.record_retention_at',true),'')::timestamptz
   AND NOT EXISTS(SELECT 1 FROM semantic.hidden_candidate h WHERE h.route=l.route AND h.subject_id=l.subject_id
    AND h.candidate_id=l.candidate_id AND h.visibility='taken_down') INTO valid
   FROM semantic.record_lifecycle l WHERE l.route=p_route AND l.subject_id=work.owner_id AND l.candidate_id=work.record_id;
 ELSE
  SELECT c.state='deleted' AND NOT c.held AND c.deleted_at=work.deleted_at
   AND c.purge_after<=nullif(current_setting('semantic.record_retention_at',true),'')::timestamptz INTO valid
   FROM semantic.context c WHERE c.route=p_route AND c.context_id=work.record_id AND c.kind='community';
 END IF;
 IF NOT coalesce(valid,false) THEN RETURN false; END IF;
 CASE p_store
 WHEN 'candidate' THEN RETURN EXISTS(SELECT 1 FROM semantic.candidate WHERE route=p_route AND subject_id=work.owner_id AND candidate_id=work.record_id AND erasure_key=p_key);
 WHEN 'revision' THEN RETURN EXISTS(SELECT 1 FROM semantic.revision r JOIN semantic.record_lifecycle l
  ON (l.route,l.subject_id,l.revision)=(r.route,r.subject_id,r.revision) WHERE r.route=p_route AND r.subject_id=work.owner_id AND l.candidate_id=work.record_id AND r.erasure_key=p_key);
 WHEN 'fact' THEN RETURN EXISTS(SELECT 1 FROM semantic.fact WHERE route=p_route AND subject_id=work.owner_id AND statement_id=work.record_id AND erasure_key=p_key);
 WHEN 'retraction' THEN RETURN EXISTS(SELECT 1 FROM semantic.retraction WHERE route=p_route AND subject_id=work.owner_id AND candidate_id=work.record_id AND erasure_key=p_key);
 WHEN 'moderation' THEN RETURN EXISTS(SELECT 1 FROM semantic.moderation WHERE route=p_route AND subject_id=work.owner_id AND candidate_id=work.record_id AND erasure_key=p_key);
 WHEN 'source_candidate' THEN RETURN EXISTS(SELECT 1 FROM semantic.source_candidate WHERE route=p_route AND subject_id=work.owner_id AND candidate_id=work.record_id AND erasure_key=p_key);
 WHEN 'statement_disclosure' THEN RETURN EXISTS(SELECT 1 FROM semantic.statement_disclosure WHERE route=p_route AND subject_id=work.owner_id AND candidate_id=work.record_id AND erasure_key=p_key);
 WHEN 'context' THEN RETURN work.kind='context' AND EXISTS(SELECT 1 FROM semantic.context WHERE route=p_route AND context_id=work.record_id AND erasure_key=p_key);
 WHEN 'context_extension' THEN RETURN work.kind='context' AND EXISTS(SELECT 1 FROM semantic.context_extension WHERE route=p_route AND context_id=work.record_id AND erasure_key=p_key);
 ELSE RETURN false;
 END CASE;
END; $$;
-- Extend the existing exact immutable guards; the account authority and field allowlists stay intact.
CREATE OR REPLACE FUNCTION semantic.prevent_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') AND semantic.erasure_mutation_allowed(TG_TABLE_NAME,OLD.route,OLD.erasure_key) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.operation='retract' AND NEW.body='{}'::jsonb AND NEW.release IS NULL
   AND (to_jsonb(NEW)-ARRAY['operation','body','release'])=(to_jsonb(OLD)-ARRAY['operation','body','release']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_OP='UPDATE' AND semantic.record_retention_mutation_allowed(TG_TABLE_NAME,OLD.route,OLD.erasure_key)
  AND NEW.operation='retract' AND NEW.body='{}'::jsonb AND NEW.release IS NULL
  AND (to_jsonb(NEW)-ARRAY['operation','body','release'])=(to_jsonb(OLD)-ARRAY['operation','body','release']) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND OLD.kind='label' AND EXISTS(SELECT 1 FROM semantic.account_agent_subject a
  WHERE a.agent_id=OLD.subject_id AND a.account_route=OLD.route) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE='23514';
END; $$;
CREATE OR REPLACE FUNCTION semantic.prevent_moderation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (semantic.erasure_mutation_allowed(TG_TABLE_NAME,OLD.route,OLD.erasure_key)
  OR semantic.record_retention_mutation_allowed(TG_TABLE_NAME,OLD.route,OLD.erasure_key))
  AND NEW.body='{}'::jsonb AND NEW.actor IS NULL
  AND (to_jsonb(NEW)-ARRAY['body','actor'])=(to_jsonb(OLD)-ARRAY['body','actor']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Semantic moderation records are immutable' USING ERRCODE='23514';
END; $$;
-- The revision guard is extended below, preserving every existing account-erasure allowance.

CREATE OR REPLACE FUNCTION semantic.prevent_revision_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND semantic.erasure_mutation_allowed(TG_TABLE_NAME,coalesce((to_jsonb(OLD)->>'route')::integer,(to_jsonb(OLD)->>'partition_no')::integer*16),(to_jsonb(OLD)->>'erasure_key')::bigint) THEN
    IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('external_claim','acceptance') THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND (
      (TG_TABLE_NAME='candidate' AND to_jsonb(NEW)->'statement'='{}'::jsonb AND (to_jsonb(NEW)-ARRAY['statement','erasure_private'])=(to_jsonb(OLD)-ARRAY['statement','erasure_private']) AND to_jsonb(NEW)->'erasure_private'='true'::jsonb)
      OR (TG_TABLE_NAME='revision' AND to_jsonb(NEW)->'source'='null'::jsonb AND to_jsonb(NEW)->'verification_receipt_id'='null'::jsonb AND to_jsonb(NEW)->'revocation_receipt_id'='null'::jsonb AND (to_jsonb(NEW)-ARRAY['source','verification_receipt_id','revocation_receipt_id'])=(to_jsonb(OLD)-ARRAY['source','verification_receipt_id','revocation_receipt_id']))
      OR (TG_TABLE_NAME='retraction' AND to_jsonb(NEW)->'references'='[]'::jsonb AND (to_jsonb(NEW)-'references')=(to_jsonb(OLD)-'references'))
      OR (TG_TABLE_NAME='adoption' AND to_jsonb(NEW)->'selection'='[]'::jsonb AND to_jsonb(NEW)->>'mode'='suppress' AND (to_jsonb(NEW)-ARRAY['selection','mode'])=(to_jsonb(OLD)-ARRAY['selection','mode']))
    ) THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' AND semantic.record_retention_mutation_allowed(TG_TABLE_NAME,
    (to_jsonb(OLD)->>'route')::integer,(to_jsonb(OLD)->>'erasure_key')::bigint) AND (
    (TG_TABLE_NAME='candidate' AND to_jsonb(NEW)->'statement'='{}'::jsonb AND to_jsonb(NEW)->'erasure_private'='true'::jsonb
     AND (to_jsonb(NEW)-ARRAY['statement','erasure_private'])=(to_jsonb(OLD)-ARRAY['statement','erasure_private']))
    OR (TG_TABLE_NAME='revision' AND to_jsonb(NEW)->'source'='null'::jsonb
     AND to_jsonb(NEW)->'verification_receipt_id'='null'::jsonb AND to_jsonb(NEW)->'revocation_receipt_id'='null'::jsonb
     AND (to_jsonb(NEW)-ARRAY['source','verification_receipt_id','revocation_receipt_id'])=(to_jsonb(OLD)-ARRAY['source','verification_receipt_id','revocation_receipt_id']))
    OR (TG_TABLE_NAME='retraction' AND to_jsonb(NEW)->'references'='[]'::jsonb
     AND (to_jsonb(NEW)-'references')=(to_jsonb(OLD)-'references'))
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE = '23514'; END; $$;

CREATE FUNCTION semantic.validate_record_deletion_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.deletion_generation=OLD.deletion_generation THEN RETURN NEW; END IF;
 INSERT INTO semantic.record_retention_commit(route,subject_id,candidate_id,deletion_generation,
   transaction_id,epoch,position,deleted_at,purge_after)
 SELECT NEW.route,NEW.subject_id,NEW.candidate_id,NEW.deletion_generation,b.transaction_id,b.epoch,b.position,
   NEW.deleted_at,NEW.purge_after FROM editorial.write_basis b WHERE b.partition_no=NEW.route/16
   AND b.transaction_id=NEW.deletion_transaction_id AND b.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN RAISE EXCEPTION 'record_deletion_requires_same_native_commit'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER record_lifecycle_native_commit AFTER INSERT OR UPDATE ON semantic.record_lifecycle
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_record_deletion_commit();
CREATE FUNCTION semantic.protect_record_retention_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'record_retention_commit_is_immutable'; END; $$;
CREATE TRIGGER record_retention_commit_immutable BEFORE UPDATE OR DELETE ON semantic.record_retention_commit
 FOR EACH ROW EXECUTE FUNCTION semantic.protect_record_retention_commit();
CREATE INDEX record_retention_document_pending ON semantic.record_retention_document
 (route,subject_id,candidate_id,deletion_generation,document_id) WHERE NOT minimized;
-- Existing deleted keys are enrolled once during migration; each later step remains key/fragment bounded.
INSERT INTO semantic.record_retention_key(partition_no,route,kind,owner_id,record_id,deleted_at)
 SELECT route/16,route,'context',context_id,context_id,deleted_at FROM semantic.context WHERE state='deleted';
CREATE INDEX record_retention_disclosure ON semantic.statement_disclosure(route,subject_id,candidate_id,erasure_key);
INSERT INTO semantic.record_retention_home(partition_no)
 SELECT DISTINCT partition_no FROM semantic.record_retention_key ON CONFLICT DO NOTHING;
-- migrate:down
-- Payload removal is irreversible. Restoring an earlier schema needs an explicit operator migration.
DO $$ BEGIN RAISE EXCEPTION 'record_retention_is_irreversible'; END $$;
