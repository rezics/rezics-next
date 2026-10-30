-- migrate:up
-- Locators carry only native record ordinals, roles and commit identities, never business keys or payload.
CREATE SEQUENCE semantic.erasure_record_key;
CREATE TABLE semantic.erasure_locator (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 account_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('actor','author','editor','acting-human','delegate','owner','subject','operator')),
 store text NOT NULL, record_key bigint NOT NULL, source_transaction_id uuid,
 source_position bigint, delivery_position bigint NOT NULL,
 projection_global boolean NOT NULL DEFAULT false,
 priority smallint GENERATED ALWAYS AS (CASE WHEN projection_global THEN 1 ELSE CASE store WHEN 'inbound_link' THEN 0 WHEN 'outbound_link' THEN 0 WHEN 'source_candidate' THEN 0 WHEN 'external_claim' THEN 0 WHEN 'acceptance' THEN 0 WHEN 'acceptance_current' THEN -1 WHEN 'retraction' THEN 0 WHEN 'statement_disclosure' THEN 0 WHEN 'release_composite' THEN 0 WHEN 'context_extension_activation' THEN 0 WHEN 'context_extension' THEN 1 WHEN 'fact' THEN 2 WHEN 'candidate' THEN 3 WHEN 'account_agent_subject' THEN 7 WHEN 'revision' THEN 8 WHEN 'write_basis' THEN 9 ELSE 4 END END) STORED,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','minimized')),
 PRIMARY KEY(partition_no,account_id,role,store,record_key)
);
CREATE INDEX erasure_locator_work ON semantic.erasure_locator(partition_no,account_id,priority,store,record_key,role) WHERE state='pending';
CREATE INDEX erasure_locator_record ON semantic.erasure_locator(partition_no,store,record_key,account_id,role);
CREATE INDEX erasure_locator_source ON semantic.erasure_locator(partition_no,source_transaction_id,store,record_key,account_id,role);
CREATE INDEX erasure_locator_event ON semantic.erasure_locator(partition_no,delivery_position,store,record_key,account_id,role);
CREATE TABLE semantic.erasure_fence (
 route integer NOT NULL, account_id uuid NOT NULL, at timestamptz,
 PRIMARY KEY(route,account_id)
);
CREATE TABLE semantic.erasure_progress (
 route integer NOT NULL, account_id uuid NOT NULL, at timestamptz NOT NULL,
 partition_no integer NOT NULL DEFAULT 0 CHECK(partition_no BETWEEN 0 AND 4096),
 state text NOT NULL DEFAULT 'local' CHECK(state IN ('local','pending-shared-custody')),
 applied boolean NOT NULL DEFAULT false,
 workflow_id text,
 PRIMARY KEY(route,account_id), FOREIGN KEY(route,account_id) REFERENCES access.erasure(route,account_id)
);
CREATE TABLE semantic.erasure_home (
 partition_no integer NOT NULL, account_id uuid NOT NULL, at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'local' CHECK(state IN ('local','complete')),
 applied boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,account_id)
);
CREATE TABLE semantic.erasure_inbox (
 route integer NOT NULL, account_id uuid NOT NULL, source_partition integer NOT NULL,
 store text NOT NULL, record_key bigint NOT NULL, role text NOT NULL, delivery_position bigint NOT NULL, late boolean NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','minimized','resolved')),
 PRIMARY KEY(route,account_id,source_partition,store,record_key,role,delivery_position)
);
CREATE INDEX erasure_inbox_unsettled ON semantic.erasure_inbox(route,account_id,source_partition,store,record_key,role,delivery_position)
 WHERE late AND state<>'resolved';
CREATE TABLE semantic.erasure_provenance (
 partition_no integer NOT NULL, transaction_id uuid NOT NULL, record_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key'),
 minimized boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,transaction_id), UNIQUE(partition_no,record_key)
);
CREATE TABLE semantic.erasure_shared_custody (
 partition_no integer NOT NULL, account_id uuid NOT NULL, role text NOT NULL, transaction_id uuid NOT NULL,
 outbox_position bigint, state text NOT NULL DEFAULT 'pending' CHECK(state='pending'),
 PRIMARY KEY(partition_no,account_id,role,transaction_id)
);
-- Per-native-transaction attribution for platform producers. These rows contain no copied payload.
CREATE TABLE semantic.erasure_source_role (
 partition_no integer NOT NULL, transaction_id uuid NOT NULL, account_id uuid NOT NULL, role text NOT NULL,
 PRIMARY KEY(partition_no,transaction_id,account_id,role)
);
CREATE TABLE semantic.erasure_copy_role (
 partition_no integer NOT NULL, store text NOT NULL, record_key bigint NOT NULL, transaction_id uuid NOT NULL,
 account_id uuid NOT NULL, role text NOT NULL,
 PRIMARY KEY(partition_no,store,record_key,transaction_id,account_id,role)
);
CREATE TABLE semantic.erasure_delivery (
 partition_no integer NOT NULL, source_position bigint NOT NULL,
 after_store text NOT NULL DEFAULT '', after_key bigint NOT NULL DEFAULT 0,
 after_account uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', after_role text NOT NULL DEFAULT '',
 complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,source_position)
);
-- This function receives exact producer values; it never enumerates payload JSON or the account graph.
CREATE FUNCTION semantic.record_erasure_locator(p_home integer,p_account uuid,p_role text,p_store text,p_key bigint,p_tx uuid,p_position bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE delivery bigint; is_global boolean:=false;
BEGIN
 SELECT position INTO delivery FROM core.partition WHERE partition_no=p_home;
 IF p_position IS NULL THEN SELECT position INTO p_position FROM core.partition WHERE partition_no=p_home; END IF;
 IF p_store='outbound_link' THEN SELECT context_id='00000000-0000-8000-8000-000000000000' INTO is_global FROM semantic.outbound_link WHERE route BETWEEN p_home*16 AND p_home*16+15 AND erasure_key=p_key;
 ELSIF p_store='inbound_link' THEN SELECT context_id='00000000-0000-8000-8000-000000000000' INTO is_global FROM semantic.inbound_link WHERE route BETWEEN p_home*16 AND p_home*16+15 AND erasure_key=p_key; END IF;
 IF p_account IS NULL OR p_account='00000000-0000-0000-0000-000000000000' OR p_account='00000000-0000-8000-8000-000000000001' THEN RETURN; END IF;
 INSERT INTO semantic.erasure_locator(partition_no,account_id,role,store,record_key,source_transaction_id,source_position,delivery_position,projection_global)
 VALUES(p_home,p_account,p_role,p_store,p_key,p_tx,p_position,delivery,coalesce(is_global,false))
 ON CONFLICT(partition_no,account_id,role,store,record_key) DO UPDATE
 SET source_transaction_id=EXCLUDED.source_transaction_id,source_position=EXCLUDED.source_position,delivery_position=EXCLUDED.delivery_position,
 state=CASE WHEN semantic.erasure_locator.delivery_position IS DISTINCT FROM EXCLUDED.delivery_position THEN 'pending' ELSE semantic.erasure_locator.state END;
 -- A new native local obligation invalidates a previously empty local page. Late resolution uses the account-home inbox.
 UPDATE semantic.erasure_home SET state='local' WHERE partition_no=p_home AND account_id=p_account AND state='complete' AND EXISTS (SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=p_account AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.state='pending');
END; $$;
CREATE FUNCTION semantic.capture_erasure_roles(p_home integer,p_store text,p_key bigint,p_tx uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;
BEGIN
 SELECT position INTO native_position FROM core.partition WHERE partition_no=p_home;
 FOR r IN SELECT account_id,role FROM semantic.erasure_copy_role
   WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=p_tx LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,p_tx,native_position);
 END LOOP;
 FOR r IN SELECT transaction_id,account_id,role FROM semantic.erasure_source_role
   WHERE partition_no=p_home AND transaction_id IN (p_tx,nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid) LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,r.transaction_id,native_position);
 END LOOP;
 SELECT * INTO b FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=p_tx;
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,p_tx)
 ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
 RETURNING record_key INTO provenance_key;
 IF b.principal_kind='account' THEN
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor','write_basis',provenance_key,p_tx,b.position);
 END IF;
 IF b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN
  acting_human:=split_part(b.requested_by,':',4)::uuid;
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human','write_basis',provenance_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'delegate',p_store,p_key,p_tx,b.position);
 END IF;
END; $$;
ALTER TABLE semantic.fact ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX fact_erasure_key ON semantic.fact(erasure_key,route);
CREATE FUNCTION semantic.capture_fact_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'fact',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER fact_erasure_capture AFTER INSERT OR UPDATE ON semantic.fact
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_fact_erasure();
ALTER TABLE semantic.revision ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX revision_erasure_key ON semantic.revision(erasure_key,route);
CREATE FUNCTION semantic.capture_revision_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'revision',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER revision_erasure_capture AFTER INSERT OR UPDATE ON semantic.revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_revision_erasure();
ALTER TABLE semantic.candidate ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX candidate_erasure_key ON semantic.candidate(erasure_key,route);
CREATE FUNCTION semantic.capture_candidate_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'candidate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER candidate_erasure_capture AFTER INSERT OR UPDATE ON semantic.candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_candidate_erasure();
ALTER TABLE semantic.acceptance ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX acceptance_erasure_key ON semantic.acceptance(erasure_key,route);
CREATE FUNCTION semantic.capture_acceptance_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'acceptance',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER acceptance_erasure_capture AFTER INSERT OR UPDATE ON semantic.acceptance
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_acceptance_erasure();
ALTER TABLE semantic.acceptance_current ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX acceptance_current_erasure_key ON semantic.acceptance_current(erasure_key,route);
CREATE FUNCTION semantic.capture_acceptance_current_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'acceptance_current',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER acceptance_current_erasure_capture AFTER INSERT OR UPDATE ON semantic.acceptance_current
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_acceptance_current_erasure();
ALTER TABLE semantic.adoption ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX adoption_erasure_key ON semantic.adoption(erasure_key,route);
CREATE FUNCTION semantic.capture_adoption_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'adoption',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER adoption_erasure_capture AFTER INSERT OR UPDATE ON semantic.adoption
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_adoption_erasure();
ALTER TABLE semantic.retraction ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX retraction_erasure_key ON semantic.retraction(erasure_key,route);
CREATE FUNCTION semantic.capture_retraction_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'retraction',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER retraction_erasure_capture AFTER INSERT OR UPDATE ON semantic.retraction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_retraction_erasure();
ALTER TABLE semantic.hidden_candidate ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX hidden_candidate_erasure_key ON semantic.hidden_candidate(erasure_key,route);
CREATE FUNCTION semantic.capture_hidden_candidate_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.moderation WHERE route=NEW.route AND subject_id=NEW.subject_id AND security_revision=NEW.security_revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'hidden_candidate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER hidden_candidate_erasure_capture AFTER INSERT OR UPDATE ON semantic.hidden_candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_hidden_candidate_erasure();
ALTER TABLE semantic.moderation ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX moderation_erasure_key ON semantic.moderation(erasure_key,route);
CREATE FUNCTION semantic.capture_moderation_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'moderation',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.actor,'operator','moderation',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER moderation_erasure_capture AFTER INSERT OR UPDATE ON semantic.moderation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_moderation_erasure();
ALTER TABLE semantic.context ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX context_erasure_key ON semantic.context(erasure_key,route);
CREATE FUNCTION semantic.capture_context_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER context_erasure_capture AFTER INSERT OR UPDATE ON semantic.context
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_erasure();
ALTER TABLE semantic.context_extension ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX context_extension_erasure_key ON semantic.context_extension(erasure_key,route);
CREATE FUNCTION semantic.capture_context_extension_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context_extension',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER context_extension_erasure_capture AFTER INSERT OR UPDATE ON semantic.context_extension
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_extension_erasure();
ALTER TABLE semantic.context_extension_activation ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX context_extension_activation_erasure_key ON semantic.context_extension_activation(erasure_key,route);
CREATE FUNCTION semantic.capture_context_extension_activation_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context_extension_activation',NEW.erasure_key,native_tx);
 SELECT recorded_transaction_id INTO native_tx FROM semantic.context_extension WHERE route=NEW.route AND context_id=NEW.context_id AND digest=NEW.digest;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context_extension_activation',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER context_extension_activation_erasure_capture AFTER INSERT OR UPDATE ON semantic.context_extension_activation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_extension_activation_erasure();
ALTER TABLE semantic.definition_release ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX definition_release_erasure_key ON semantic.definition_release(erasure_key,route);
CREATE FUNCTION semantic.capture_definition_release_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'definition_release',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER definition_release_erasure_capture AFTER INSERT OR UPDATE ON semantic.definition_release
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_definition_release_erasure();
ALTER TABLE semantic.definition_activation ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX definition_activation_erasure_key ON semantic.definition_activation(erasure_key,route);
CREATE FUNCTION semantic.capture_definition_activation_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'definition_activation',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER definition_activation_erasure_capture AFTER INSERT OR UPDATE ON semantic.definition_activation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_definition_activation_erasure();
ALTER TABLE semantic.external_claim ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX external_claim_erasure_key ON semantic.external_claim(erasure_key,route);
CREATE FUNCTION semantic.capture_external_claim_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'external_claim',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER external_claim_erasure_capture AFTER INSERT OR UPDATE ON semantic.external_claim
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_external_claim_erasure();
ALTER TABLE semantic.source_candidate ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX source_candidate_erasure_key ON semantic.source_candidate(erasure_key,route);
CREATE FUNCTION semantic.capture_source_candidate_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT r.recorded_transaction_id FROM semantic.candidate c JOIN semantic.revision r USING(route,subject_id,revision) WHERE c.route=NEW.route AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'source_candidate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER source_candidate_erasure_capture AFTER INSERT OR UPDATE ON semantic.source_candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_source_candidate_erasure();
ALTER TABLE semantic.statement_disclosure ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX statement_disclosure_erasure_key ON semantic.statement_disclosure(erasure_key,route);
CREATE FUNCTION semantic.capture_statement_disclosure_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT r.recorded_transaction_id FROM semantic.candidate c JOIN semantic.revision r USING(route,subject_id,revision) WHERE c.route=NEW.route AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'statement_disclosure',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.account_id,'subject','statement_disclosure',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER statement_disclosure_erasure_capture AFTER INSERT OR UPDATE ON semantic.statement_disclosure
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_statement_disclosure_erasure();
ALTER TABLE semantic.subject ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX subject_erasure_key ON semantic.subject(erasure_key,route);
CREATE FUNCTION semantic.capture_subject_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'subject',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER subject_erasure_capture AFTER INSERT OR UPDATE ON semantic.subject
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_subject_erasure();
ALTER TABLE semantic.redirect ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX redirect_erasure_key ON semantic.redirect(erasure_key,route);
CREATE FUNCTION semantic.capture_redirect_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'redirect',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER redirect_erasure_capture AFTER INSERT OR UPDATE ON semantic.redirect
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_redirect_erasure();
ALTER TABLE semantic.account_agent_subject ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX account_agent_subject_erasure_key ON semantic.account_agent_subject(erasure_key,route);
CREATE FUNCTION semantic.capture_account_agent_subject_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'account_agent_subject',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.account_id,'subject','account_agent_subject',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER account_agent_subject_erasure_capture AFTER INSERT OR UPDATE ON semantic.account_agent_subject
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_account_agent_subject_erasure();
ALTER TABLE semantic.account_agent_moved_link ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX account_agent_moved_link_erasure_key ON semantic.account_agent_moved_link(erasure_key,route);
CREATE FUNCTION semantic.capture_account_agent_moved_link_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'account_agent_moved_link',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.account_id,'subject','account_agent_moved_link',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER account_agent_moved_link_erasure_capture AFTER INSERT OR UPDATE ON semantic.account_agent_moved_link
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_account_agent_moved_link_erasure();
ALTER TABLE semantic.outbound_link ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX outbound_link_erasure_key ON semantic.outbound_link(erasure_key,route);
CREATE FUNCTION semantic.capture_outbound_link_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'outbound_link',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER outbound_link_erasure_capture AFTER INSERT OR UPDATE ON semantic.outbound_link
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_outbound_link_erasure();
ALTER TABLE semantic.inbound_link ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX inbound_link_erasure_key ON semantic.inbound_link(erasure_key,route);
CREATE FUNCTION semantic.capture_inbound_link_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'inbound_link',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER inbound_link_erasure_capture AFTER INSERT OR UPDATE ON semantic.inbound_link
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_inbound_link_erasure();
ALTER TABLE semantic.identity_epoch_job ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_job_erasure_key ON semantic.identity_epoch_job(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_job_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_job',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_job_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_job
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_job_erasure();
ALTER TABLE semantic.identity_epoch_home_gate ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_home_gate_erasure_key ON semantic.identity_epoch_home_gate(erasure_key,route);
CREATE FUNCTION semantic.capture_identity_epoch_home_gate_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'identity_epoch_home_gate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_home_gate_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_home_gate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_home_gate_erasure();
ALTER TABLE semantic.identity_epoch_mapping ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_mapping_erasure_key ON semantic.identity_epoch_mapping(erasure_key,route);
CREATE FUNCTION semantic.capture_identity_epoch_mapping_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'identity_epoch_mapping',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_mapping_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_erasure();
ALTER TABLE semantic.identity_epoch_ack ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_ack_erasure_key ON semantic.identity_epoch_ack(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_ack_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_ack',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_ack_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_ack
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_ack_erasure();
ALTER TABLE semantic.identity_epoch_admission_attempt ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_admission_attempt_erasure_key ON semantic.identity_epoch_admission_attempt(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_admission_attempt_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_admission_attempt',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_admission_attempt_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_attempt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_attempt_erasure();
ALTER TABLE semantic.identity_epoch_admission_plan ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_admission_plan_erasure_key ON semantic.identity_epoch_admission_plan(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_admission_plan_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_admission_plan',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_admission_plan_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_plan
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_plan_erasure();
ALTER TABLE semantic.identity_epoch_admission_receipt ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_admission_receipt_erasure_key ON semantic.identity_epoch_admission_receipt(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_admission_receipt_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_admission_receipt',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_admission_receipt_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_receipt_erasure();
ALTER TABLE semantic.identity_epoch_admission_source ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_admission_source_erasure_key ON semantic.identity_epoch_admission_source(erasure_key,route);
CREATE FUNCTION semantic.capture_identity_epoch_admission_source_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'identity_epoch_admission_source',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_admission_source_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_source
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_source_erasure();
ALTER TABLE semantic.identity_epoch_change ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_change_erasure_key ON semantic.identity_epoch_change(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_change_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_change',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_change_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_change
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_change_erasure();
ALTER TABLE semantic.identity_epoch_effect_receipt ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_effect_receipt_erasure_key ON semantic.identity_epoch_effect_receipt(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_effect_receipt_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_effect_receipt',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_effect_receipt_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_effect_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_effect_receipt_erasure();
ALTER TABLE semantic.identity_epoch_input ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_input_erasure_key ON semantic.identity_epoch_input(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_input_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_input',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_input_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_input
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_input_erasure();
ALTER TABLE semantic.identity_epoch_step ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX identity_epoch_step_erasure_key ON semantic.identity_epoch_step(partition_no,erasure_key);
CREATE FUNCTION semantic.capture_identity_epoch_step_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_step',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_step_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_step
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_step_erasure();
ALTER TABLE zones.zone ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX zone_erasure_key ON zones.zone(erasure_key,route);
CREATE FUNCTION semantic.capture_zone_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'zone',NEW.erasure_key,NEW.transaction_id);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.owner_id,'owner','zone',NEW.erasure_key,NEW.transaction_id,NULL);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER zone_erasure_capture AFTER INSERT OR UPDATE ON zones.zone
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_zone_erasure();
CREATE FUNCTION semantic.capture_resource_role_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k bigint;
BEGIN
 IF NEW.subject_kind<>'identity' OR NEW.grant_role NOT IN ('semantic.context.owner','semantic.zone.owner') THEN RETURN NEW; END IF;
 IF NEW.grant_role='semantic.context.owner' THEN
  SELECT erasure_key INTO k FROM semantic.context WHERE route=NEW.route AND context_id=NEW.resource_id;
  IF k IS NOT NULL THEN PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.subject_id,'owner','context',k,NEW.transaction_id,NULL); END IF;
 ELSE
  SELECT erasure_key INTO k FROM zones.zone WHERE route=NEW.route AND zone_id=NEW.resource_id;
  IF k IS NOT NULL THEN PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.subject_id,'owner','zone',k,NEW.transaction_id,NULL); END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER semantic_resource_role_erasure AFTER INSERT OR UPDATE ON access.resource_role_grant
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_resource_role_erasure();
ALTER TABLE semantic.release_composite ADD COLUMN erasure_key bigint NOT NULL DEFAULT nextval('semantic.erasure_record_key');
CREATE UNIQUE INDEX release_composite_erasure_key ON semantic.release_composite(erasure_key,extension_route);
CREATE INDEX release_composite_extension ON semantic.release_composite(extension_route,extension_context_id,extension_digest,digest);
CREATE FUNCTION semantic.capture_release_composite_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 SELECT recorded_transaction_id INTO native_tx FROM semantic.context_extension
 WHERE route=NEW.extension_route AND context_id=NEW.extension_context_id AND digest=NEW.extension_digest;
 PERFORM semantic.capture_erasure_roles(NEW.extension_route/16,'release_composite',NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER release_composite_erasure_capture AFTER INSERT OR UPDATE ON semantic.release_composite
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_release_composite_erasure();
ALTER TABLE semantic.moderation ALTER COLUMN actor DROP NOT NULL;
CREATE INDEX context_extension_activation_child ON semantic.context_extension_activation(route,context_id,digest,head);
ALTER TABLE semantic.candidate ADD COLUMN erasure_private boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.statement_disclosure ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE semantic.inbound_link ADD COLUMN erasure_roles jsonb NOT NULL DEFAULT '[]';
ALTER TABLE semantic.outbound_link ADD COLUMN erasure_roles jsonb NOT NULL DEFAULT '[]';
CREATE FUNCTION semantic.capture_copy_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; existing_key bigint;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 -- BEFORE INSERT also runs for ON CONFLICT. Use the exact receiving native key, never the discarded sequence value.
 IF TG_OP='INSERT' THEN
  IF TG_TABLE_NAME='inbound_link' THEN
   SELECT erasure_key INTO existing_key FROM semantic.inbound_link x WHERE x.route=NEW.route AND x.subject_id=NEW.subject_id
    AND x.context_id=NEW.context_id AND x.property=NEW.property AND x.source_subject_id=NEW.source_subject_id
    AND x.statement_id=NEW.statement_id AND x.filter_value=NEW.filter_value;
  ELSE
   SELECT erasure_key INTO existing_key FROM semantic.outbound_link x WHERE x.route=NEW.route AND x.subject_id=NEW.subject_id
    AND x.context_id=NEW.context_id AND x.property=NEW.property AND x.statement_id=NEW.statement_id AND x.filter_value=NEW.filter_value AND x.order_key=NEW.order_key AND x.target_subject_id=NEW.target_subject_id;
  END IF;
  IF existing_key IS NOT NULL THEN NEW.erasure_key:=existing_key; END IF;
 END IF;
 FOR r IN SELECT * FROM jsonb_to_recordset(NEW.erasure_roles) AS x(account_id uuid,role text) LOOP
  INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role) VALUES(NEW.route/16,TG_TABLE_NAME,NEW.erasure_key,NEW.recorded_transaction_id,r.account_id,r.role) ON CONFLICT DO NOTHING;
 END LOOP;
 NEW.erasure_roles:='[]';
 RETURN NEW;
END; $$;
CREATE TRIGGER inbound_copy_erasure BEFORE INSERT OR UPDATE ON semantic.inbound_link FOR EACH ROW EXECUTE FUNCTION semantic.capture_copy_erasure();
CREATE TRIGGER outbound_copy_erasure BEFORE INSERT OR UPDATE ON semantic.outbound_link FOR EACH ROW EXECUTE FUNCTION semantic.capture_copy_erasure();
-- Platform cleanup is bound to the exact local locator and a copied committed native obligation.
-- A setting alone is insufficient; the pending locator, local obligation and exact row must all match.
CREATE FUNCTION semantic.erasure_mutation_allowed(p_store text,p_route integer,p_key bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT current_setting('semantic.erasure_cleanup',true)='on' AND EXISTS (
 SELECT 1 FROM semantic.erasure_locator l JOIN semantic.erasure_home h USING(partition_no,account_id)
 WHERE l.partition_no=p_route/16 AND l.account_id=nullif(current_setting('semantic.erasure_account',true),'')::uuid
 AND l.store=p_store AND l.record_key=p_key AND l.state='pending' AND h.state='local')
$$;
CREATE OR REPLACE FUNCTION semantic.prevent_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND semantic.erasure_mutation_allowed(TG_TABLE_NAME,coalesce((to_jsonb(OLD)->>'route')::integer,(to_jsonb(OLD)->>'partition_no')::integer*16),(to_jsonb(OLD)->>'erasure_key')::bigint) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND NEW.operation='retract' AND NEW.body='{}'::jsonb AND NEW.release IS NULL
      AND (to_jsonb(NEW)-ARRAY['operation','body','release'])=(to_jsonb(OLD)-ARRAY['operation','body','release']) THEN RETURN NEW; END IF;
  END IF;
  -- Only the derived account node's display label is erasable personal data.
  IF TG_OP = 'DELETE' AND OLD.kind = 'label' AND EXISTS (
    SELECT 1 FROM semantic.account_agent_subject account
    WHERE account.agent_id = OLD.subject_id AND account.account_route = OLD.route
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE OR REPLACE FUNCTION semantic.prevent_moderation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND semantic.erasure_mutation_allowed(TG_TABLE_NAME,coalesce((to_jsonb(OLD)->>'route')::integer,(to_jsonb(OLD)->>'partition_no')::integer*16),(to_jsonb(OLD)->>'erasure_key')::bigint) THEN
    IF TG_OP='UPDATE' AND NEW.body='{}'::jsonb AND NEW.actor IS NULL
     AND (to_jsonb(NEW)-ARRAY['body','actor'])=(to_jsonb(OLD)-ARRAY['body','actor']) THEN RETURN NEW; END IF;
  END IF; RAISE EXCEPTION 'Semantic moderation records are immutable' USING ERRCODE = '23514'; END; $$;
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
  END IF; RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE = '23514'; END; $$;

CREATE OR REPLACE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND semantic.erasure_mutation_allowed('identity_epoch_job',OLD.partition_no*16,OLD.erasure_key)
   AND NEW.receipt='{"kind":"erased"}'::jsonb AND NEW.receipt_key='erased:'||OLD.job_id::text
   AND NEW.intent=(OLD.intent-'verificationReceipt')
   AND (to_jsonb(NEW)-ARRAY['intent','receipt','receipt_key'])=(to_jsonb(OLD)-ARRAY['intent','receipt','receipt_key']) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state='published' THEN
  RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;

-- migrate:down
-- Forward-only: erasure obligations and replay fences must not be rolled back.
