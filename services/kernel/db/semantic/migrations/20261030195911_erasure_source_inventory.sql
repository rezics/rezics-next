-- migrate:up
-- Closed native source coordinates, captured before local minimization. No business bodies.
ALTER TABLE semantic.erasure_progress ADD COLUMN source_protocol integer NOT NULL DEFAULT 0,
 ADD COLUMN source_version integer;
CREATE TABLE semantic.erasure_source_seal (
 partition_no integer NOT NULL, account_id uuid NOT NULL, version integer NOT NULL, at timestamptz NOT NULL,
 PRIMARY KEY(partition_no,account_id)
);
CREATE TABLE semantic.erasure_source_record (
 partition_no integer NOT NULL, account_id uuid NOT NULL, role text NOT NULL, store text NOT NULL,
 record_key bigint NOT NULL, delivery_position bigint NOT NULL, source_transaction_id uuid, source_position bigint,
 native_present boolean NOT NULL, original uuid, previous_terminal uuid, identity_epoch bigint,
 slot_id uuid, candidate_id uuid, property text, release text, context_id uuid,
 source_name text, external_id text, field_group text,
 PRIMARY KEY(partition_no,account_id,role,store,record_key,delivery_position)
);
CREATE INDEX erasure_source_record_key ON semantic.erasure_source_record(partition_no,account_id,store,record_key,role,delivery_position);
CREATE INDEX erasure_inbox_source_page ON semantic.erasure_inbox(route,account_id,source_partition,store,record_key,role,delivery_position);
-- One retained page, including exact released native custody, per erased account.
CREATE TABLE semantic.erasure_source_page (
 route integer NOT NULL, account_id uuid NOT NULL, version integer NOT NULL, at timestamptz NOT NULL,
 id uuid NOT NULL, previous_id uuid, source_partition integer, store text, record_key bigint, role text, delivery_position bigint,
 source_epoch integer, source_position bigint, source_transaction_id uuid,
 role_epoch integer,role_position bigint,role_transaction_id uuid, transfer_transaction_id uuid,
 original uuid,previous_terminal uuid,current_terminal uuid,source_home integer,source_revision integer,
 source_security_revision bigint,source_release text,slot_id uuid,candidate_id uuid,property text,
 tuple_route integer,source_name text,external_id text,field_group text,
 disposition text CHECK(disposition IN ('remove','replace','retain_deidentified')),
 complete boolean NOT NULL, consumed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(route,account_id), UNIQUE(route,id)
);
-- Independent Source terminal cursor: Search consumption never advances this chain.
CREATE TABLE semantic.erasure_source_terminal (LIKE semantic.erasure_source_page INCLUDING ALL);
CREATE TABLE semantic.erasure_source_disposition (
 partition_no integer NOT NULL, store text NOT NULL, record_key bigint NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('removed','retained-nonpersonal')), transaction_id uuid NOT NULL, native_xmin text,
 PRIMARY KEY(partition_no,store,record_key)
);
CREATE TABLE semantic.erasure_source_hold (
 partition_no integer NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, version integer NOT NULL, at timestamptz NOT NULL,
 store text NOT NULL, record_key bigint NOT NULL, role text NOT NULL, delivery_position bigint NOT NULL,
 transaction_id uuid NOT NULL,
 original uuid,previous_terminal uuid,current_terminal uuid,source_home integer,source_revision integer,
 source_security_revision bigint,source_release text,slot_id uuid,candidate_id uuid,property text,
 tuple_route integer,source_name text,external_id text,field_group text,
 disposition text CHECK(disposition IN ('remove','replace','retain_deidentified')),
 PRIMARY KEY(partition_no,id)
);
-- Native fence evidence belongs to Source, not to a caller's receipt brand or a history ACK.
CREATE TABLE semantic.erasure_source_commit (
 partition_no integer NOT NULL, transaction_id uuid NOT NULL, epoch integer NOT NULL, position bigint NOT NULL,
 PRIMARY KEY(partition_no,transaction_id)
);
CREATE FUNCTION semantic.validate_erasure_source_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM editorial.write_basis b
   WHERE b.partition_no=NEW.partition_no AND b.transaction_id=NEW.transaction_id
     AND b.epoch=NEW.epoch AND b.position=NEW.position AND b.xmin::text=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'Semantic Source receipt lacks same-command native custody' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER erasure_source_native_commit AFTER INSERT ON semantic.erasure_source_commit
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_erasure_source_commit();
CREATE TRIGGER erasure_source_native_commit_immutable BEFORE UPDATE OR DELETE ON semantic.erasure_source_commit
 FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE OR REPLACE FUNCTION semantic.record_erasure_locator(p_home integer,p_account uuid,p_role text,p_store text,p_key bigint,p_tx uuid,p_position bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE delivery bigint; is_global boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM semantic.erasure_source_seal s WHERE s.partition_no=p_home AND s.account_id=p_account) THEN
  -- Re-reporting unchanged provenance of a survivor's existing row creates no new role.
  IF EXISTS(SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=p_account
    AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.source_transaction_id IS NOT DISTINCT FROM p_tx) THEN RETURN; END IF;
  RAISE EXCEPTION 'Semantic erased Source role admission is sealed' USING ERRCODE='23514';
 END IF;
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
CREATE FUNCTION semantic.capture_erasure_source_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_present boolean:=false; v_original uuid; v_old_terminal uuid; v_identity_version bigint; v_mapped_terminal uuid;
 v_slot uuid; v_candidate uuid; v_property_id text; v_release_id text; v_context uuid; v_source_name text; v_external_id text; v_field_group text;
BEGIN
 -- Closing an empty native home and admitting a late role serialize on its actual command gate.
 IF EXISTS(SELECT 1 FROM semantic.erasure_source_seal s WHERE s.partition_no=NEW.partition_no AND s.account_id=NEW.account_id) THEN
  RAISE EXCEPTION 'Semantic erased Source role admission is sealed' USING ERRCODE='23514';
 END IF;
 CASE NEW.store
 WHEN 'release_composite' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.release_composite r WHERE r.erasure_key=NEW.record_key AND extension_route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'fact' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.statement_id,r.property,r.release,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.fact r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'revision' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,r.release,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.revision r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'candidate' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.candidate_id,r.property,r.release,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.candidate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'acceptance' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.acceptance r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'acceptance_current' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.candidate_id,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.acceptance_current r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'adoption' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.adoption r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'retraction' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.retraction r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'hidden_candidate' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.hidden_candidate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'moderation' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.moderation r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'context' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.context r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'context_extension' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.context_extension r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'context_extension_activation' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.context_extension_activation r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'definition_release' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.definition_release r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'definition_activation' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.definition_activation r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'external_claim' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.external_claim r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'source_candidate' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,r.source,r.external_id,r.field_group INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.source_candidate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'provider_review_queue_key' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.provider_review_queue_key r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'provider_review_queue_entry' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.provider_review_queue_entry r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'statement_disclosure' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,r.candidate_id,r.property,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.statement_disclosure r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'subject' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.subject r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'redirect' THEN SELECT true,r.subject_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.redirect r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'account_agent_subject' THEN SELECT true,r.agent_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.account_agent_subject r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'account_agent_moved_link' THEN SELECT true,r.source_subject_id,NULL::uuid,NULL::uuid,r.statement_id,r.property,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.account_agent_moved_link r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'outbound_link' THEN SELECT true,r.subject_id,NULL::uuid,r.slot_id,r.statement_id,r.property,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.outbound_link r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'inbound_link' THEN SELECT true,r.source_subject_id,NULL::uuid,NULL::uuid,r.statement_id,r.property,NULL::text,r.context_id,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.inbound_link r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'identity_epoch_job' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_job r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_home_gate' THEN SELECT true,r.original,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_home_gate r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'identity_epoch_mapping' THEN SELECT true,r.original,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_mapping r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'identity_epoch_ack' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_ack r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_attempt' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_attempt r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_plan' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_plan r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_receipt' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_receipt r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_admission_source' THEN SELECT true,r.original,r.terminal,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_admission_source r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_change' THEN SELECT true,r.original,r.previous_terminal,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_change r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_effect_receipt' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_effect_receipt r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_input' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_input r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_step' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.identity_epoch_step r WHERE r.erasure_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'zone' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM zones.zone r WHERE r.erasure_key=NEW.record_key AND route BETWEEN NEW.partition_no*16 AND NEW.partition_no*16+15;
 WHEN 'write_basis' THEN SELECT true,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::text,NULL::text INTO v_present,v_original,v_old_terminal,v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group FROM semantic.erasure_provenance r WHERE r.record_key=NEW.record_key AND partition_no=NEW.partition_no;
 WHEN 'identity_epoch_receiving_plan' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_plan WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_receiving_record' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_record WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_receiving_effect' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_effect WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_receiving_custody' THEN SELECT true INTO v_present FROM semantic.identity_epoch_receiving_custody WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 ELSE v_present:=false;
 END CASE;
 IF v_candidate IS NOT NULL AND v_original IS NOT NULL AND
 (get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11))/16=NEW.partition_no THEN
  SELECT coalesce(v_slot,c.slot_id),coalesce(v_property_id,c.property),coalesce(v_release_id,c.release)
  INTO v_slot,v_property_id,v_release_id FROM semantic.candidate c
  WHERE c.route=(get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11)) AND c.subject_id=v_original AND c.candidate_id=v_candidate;
 END IF;
 IF v_original IS NOT NULL AND (get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11))/16=NEW.partition_no THEN
  SELECT m.terminal,m.epoch INTO v_mapped_terminal,v_identity_version
  FROM semantic.identity_epoch_mapping m WHERE m.route=(get_byte(uuid_send(v_original),10)*256+get_byte(uuid_send(v_original),11)) AND m.original=v_original;
  v_old_terminal:=coalesce(v_old_terminal,v_mapped_terminal);
 END IF;
 INSERT INTO semantic.erasure_source_record(partition_no,account_id,role,store,record_key,delivery_position,
 source_transaction_id,source_position,native_present,original,previous_terminal,identity_epoch,
 slot_id,candidate_id,property,release,context_id,source_name,external_id,field_group)
 VALUES(NEW.partition_no,NEW.account_id,NEW.role,NEW.store,NEW.record_key,NEW.delivery_position,
 NEW.source_transaction_id,NEW.source_position,coalesce(v_present,false),v_original,v_old_terminal,v_identity_version,
 v_slot,v_candidate,v_property_id,v_release_id,v_context,v_source_name,v_external_id,v_field_group)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TRIGGER erasure_source_record_capture AFTER INSERT OR UPDATE OF source_transaction_id,source_position,delivery_position
 ON semantic.erasure_locator FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_record();
-- Existing native locators are recaptured by the same exact-key producer. Missing bodies stay unresolved.
UPDATE semantic.erasure_locator SET delivery_position=delivery_position;

-- A normal source writer can delete transient or replaced native records before account T.
-- Keep its actual native deletion receipt rather than infer absence from a later missing row.
CREATE FUNCTION semantic.capture_erasure_source_removal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native_home integer; native_tx uuid;
BEGIN
 IF TG_TABLE_NAME='release_composite' THEN native_home:=OLD.extension_route/16;
 ELSIF TG_TABLE_NAME LIKE 'identity_epoch_%' AND TG_TABLE_NAME NOT IN ('identity_epoch_mapping','identity_epoch_home_gate') THEN native_home:=OLD.partition_no;
 ELSE native_home:=OLD.route/16;
 END IF;
 SELECT b.transaction_id INTO native_tx FROM core.partition p JOIN editorial.write_basis b
 ON b.partition_no=p.partition_no AND b.position=p.position
 WHERE p.partition_no=native_home AND b.xmin::text=pg_current_xact_id()::text;
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN OLD; END IF;
 IF native_tx IS NULL THEN RAISE EXCEPTION 'Semantic source removal requires native command custody' USING ERRCODE='23514'; END IF;
 INSERT INTO semantic.erasure_source_commit(partition_no,transaction_id,epoch,position)
 SELECT native_home,native_tx,epoch,position FROM core.partition WHERE partition_no=native_home
 ON CONFLICT DO NOTHING;
 INSERT INTO semantic.erasure_source_disposition(partition_no,store,record_key,disposition,transaction_id)
 VALUES(native_home,TG_TABLE_NAME,OLD.erasure_key,'removed',native_tx)
 ON CONFLICT(partition_no,store,record_key) DO UPDATE SET disposition=EXCLUDED.disposition,transaction_id=EXCLUDED.transaction_id,native_xmin=NULL;
 RETURN OLD;
END; $$;
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.release_composite
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.fact
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.acceptance
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.acceptance_current
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.adoption
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.retraction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.hidden_candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.moderation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context_extension
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context_extension_activation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.definition_release
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.definition_activation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.external_claim
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.source_candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.statement_disclosure
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.subject
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.redirect
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.account_agent_subject
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.account_agent_moved_link
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.outbound_link
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.inbound_link
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_job
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_home_gate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_mapping
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_ack
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_attempt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_plan
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_source
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_change
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_effect_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_input
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_step
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_plan
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_record
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_effect
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_custody
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.provider_review_queue_key
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();
CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.provider_review_queue_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();

-- migrate:down
-- Forward-only: do not reopen erased-role admission or discard custody.
