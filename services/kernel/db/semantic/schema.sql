--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: semantic; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA semantic;


--
-- Name: ack_identity_epoch_empty_bootstrap(integer, uuid, uuid, integer, bigint, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.ack_identity_epoch_empty_bootstrap(p_home integer, p_export uuid, p_received uuid, p_epoch integer, p_position bigint, p_tx uuid) RETURNS TABLE(applied boolean, sealed boolean)
    LANGUAGE plpgsql
    AS $$
DECLARE owner record; saved record;
BEGIN
  SELECT page.*,page.xmin page_xmin INTO saved FROM semantic.identity_epoch_bootstrap_page page
    WHERE partition_no=p_home AND transaction_id=p_export FOR UPDATE;
  IF NOT FOUND OR saved.generation<>1 OR saved.phase<>'member-dirty' OR NOT saved.caught_up
    THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  IF saved.acknowledged THEN RETURN QUERY SELECT false,false; RETURN; END IF;
  PERFORM 1 FROM semantic.identity_epoch_bootstrap_home
    WHERE partition_no=p_home AND generation=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM semantic.identity_epoch_bootstrap_basis b
    JOIN semantic.identity_epoch_native_commit c ON
      (c.partition_no,c.transaction_id,c.epoch,c.position)=(b.partition_no,b.transaction_id,b.native_epoch,b.native_position)
    JOIN semantic.identity_epoch_bootstrap_custody custody ON custody.partition_no=b.partition_no
      AND custody.source_partition=b.source_partition AND custody.source_generation=b.source_generation AND custody.stage='add'
    JOIN semantic.identity_epoch_native_commit source ON source.partition_no=b.partition_no AND source.transaction_id=b.source_transaction_id
    WHERE b.partition_no=p_home AND b.source_partition=p_home AND b.source_generation=1
      AND b.source_transaction_id=p_export AND b.transaction_id=p_received AND b.native_epoch=p_epoch AND b.native_position=p_position
      AND c.purpose='bootstrap' AND c.xmin=b.xmin AND custody.xmin=b.xmin
      AND custody.native_transaction_id=p_export AND custody.native_epoch=source.epoch AND custody.native_position=source.position
      AND source.purpose='bootstrap' AND source.epoch=p_epoch AND source.xmin=saved.page_xmin
  ) OR EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_row WHERE partition_no=p_home AND transaction_id=p_export)
    THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  SELECT * INTO owner FROM core.partition WHERE partition_no=p_home AND write_state='active'
    AND epoch=p_epoch AND position>=p_position FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  INSERT INTO semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position,purpose)
    VALUES(p_home,p_tx,owner.epoch,owner.position+1,'bootstrap');
  UPDATE semantic.identity_epoch_bootstrap_page SET acknowledged=true
    WHERE partition_no=p_home AND transaction_id=p_export;
  UPDATE semantic.identity_epoch_bootstrap_home SET sealed_generation=1,needs_work=false,
    sealed_transaction_id=p_tx,sealed_epoch=owner.epoch,sealed_position=owner.position+1
    WHERE partition_no=p_home AND owner_epoch=owner.epoch
      AND NOT EXISTS (SELECT 1 FROM semantic.identity_epoch_dirty
        WHERE route BETWEEN p_home*16 AND p_home*16+15 AND revision>captured_revision)
      AND NOT EXISTS (SELECT 1 FROM semantic.identity_epoch_member_dirty
        WHERE route BETWEEN p_home*16 AND p_home*16+15 AND revision>captured_revision);
  RETURN QUERY SELECT true,FOUND;
END; $$;


--
-- Name: acquire_identity_epoch_admission(integer, uuid, bigint, text); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.acquire_identity_epoch_admission(p_home integer, p_job uuid, p_epoch bigint, p_scope text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE a semantic.identity_epoch_admission_attempt;h semantic.identity_epoch_admission_handoff;
BEGIN
 PERFORM 1 FROM semantic.identity_epoch_control WHERE partition_no=p_home AND prepare_job=p_job AND prepare_epoch=p_epoch FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 SELECT * INTO a FROM semantic.identity_epoch_admission_attempt WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
 IF NOT FOUND OR a.state='closed' OR a.job_epoch<>p_epoch OR a.scope_digest<>p_scope THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF a.state='acquired' THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_prearm_claim WHERE partition_no=p_home AND job_id=p_job AND job_epoch=p_epoch AND scope_digest=p_scope)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 SELECT * INTO h FROM semantic.identity_epoch_admission_handoff WHERE partition_no=p_home AND job_id=p_job;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(h.inputs) i(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
 LEFT JOIN semantic.identity_epoch_prearm_directory d ON d.partition_no=p_home AND d.job_id=p_job AND d.generation=i.generation
  AND d.job_epoch=p_epoch AND d.basis_version=i.basis_version AND d.owner_epoch=i.owner_epoch AND NOT d.released
 LEFT JOIN semantic.identity_epoch_group g ON g.partition_no=p_home AND g.terminal=i.terminal AND g.generation=i.generation
  AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch
 LEFT JOIN core.partition p ON p.partition_no=p_home AND p.epoch=i.owner_epoch AND p.write_state='active'
 WHERE d.sealed_transaction_id IS NULL OR g.terminal IS NULL OR p.partition_no IS NULL)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 UPDATE semantic.identity_epoch_admission_attempt SET state='acquired' WHERE partition_no=p_home AND job_id=p_job;
 UPDATE semantic.identity_epoch_group SET pending_job=p_job,pending_epoch=p_epoch WHERE partition_no=p_home
  AND terminal IN (SELECT i.terminal FROM jsonb_to_recordset(h.inputs) i(terminal uuid));
 UPDATE semantic.identity_epoch_control SET pending_job=p_job,pending_epoch=p_epoch WHERE partition_no=p_home;
END; $$;


--
-- Name: append_record_source_set(integer, uuid, integer, jsonb); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.append_record_source_set(p_home integer, p_tx uuid, p_revision integer, p_input jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE owner semantic.record_source_set; entry jsonb; n integer; revisions integer;
BEGIN
 SELECT * INTO STRICT owner FROM semantic.record_source_set
 WHERE partition_no=p_home AND transaction_id=p_tx AND revision=p_revision FOR UPDATE;
 IF owner.sealed OR owner.native_xid<>pg_current_xact_id()::text THEN
  RAISE EXCEPTION 'Semantic record source set is not building';
 END IF;
 IF jsonb_array_length(p_input)>512 THEN RAISE EXCEPTION 'Semantic source append exceeds 512 inputs'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_input) LOOP
  INSERT INTO semantic.record_source_set_member(partition_no,transaction_id,unit_key,source_key,kind,
    subject_id,candidate_id,source_revision,document_id,field,language)
  VALUES(p_home,p_tx,entry->>'unit',entry->>'key',entry->>'kind',(entry->>'subject')::uuid,
    (entry->>'candidate')::uuid,(entry->>'revision')::integer,(entry->>'document')::uuid,
    entry->>'field',entry->>'language') ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM semantic.record_source_set_member WHERE partition_no=p_home AND transaction_id=p_tx
   AND source_hash=sha256(convert_to(entry->>'key','UTF8')) AND source_key=entry->>'key') THEN
   RAISE EXCEPTION 'Semantic source key collision';
  END IF;
 END LOOP;
 SELECT count(DISTINCT unit_key) INTO n FROM semantic.record_source_set_member
 WHERE partition_no=p_home AND transaction_id=p_tx;
 IF n>512 THEN RAISE EXCEPTION 'Semantic command exceeds the existing 512 source-member bound'; END IF;
 -- One old/current pair per actual contribution/document reference or term field/language unit.
 SELECT max(versions) INTO revisions FROM (
  SELECT count(DISTINCT source_revision) versions FROM semantic.record_source_set_member
  WHERE partition_no=p_home AND transaction_id=p_tx GROUP BY unit_key
 ) counted;
 IF revisions>2 THEN RAISE EXCEPTION 'Semantic source unit exceeds an old/current pair'; END IF;
END; $$;


--
-- Name: apply_identity_epoch_mapping_source(integer, uuid, uuid, uuid, text, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.apply_identity_epoch_mapping_source(r integer, id uuid, previous uuid, destination uuid, release_digest text, tid uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE m semantic.identity_epoch_mapping;s semantic.subject;revision_no integer;sequence_no integer;actual uuid;
BEGIN
 IF r<>get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11)
   OR NOT semantic.identity_epoch_mapping_owns(r,id)
   OR NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence f WHERE f.route=r AND f.destination=id AND f.transaction_id=tid)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 SELECT * INTO STRICT m FROM semantic.identity_epoch_mapping WHERE route=r AND original=id FOR UPDATE;
 SELECT * INTO STRICT s FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
 SELECT target,sequence INTO actual,sequence_no FROM semantic.redirect WHERE route=r AND subject_id=id ORDER BY sequence DESC LIMIT 1;
 IF m.terminal<>previous OR (destination<>id AND coalesce(actual,id)<>previous)
   OR (s.visibility<>'visible' AND previous=id) OR EXISTS(SELECT 1 FROM semantic.account_agent_subject WHERE route=r AND subject_id=id)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF previous=destination THEN RETURN true; END IF;
 SELECT revision INTO STRICT revision_no FROM semantic.revision WHERE route=r AND subject_id=id ORDER BY revision DESC LIMIT 1;
 IF destination=id THEN
  DELETE FROM semantic.redirect WHERE route=r AND subject_id=id AND sequence=sequence_no;
  IF EXISTS(SELECT 1 FROM semantic.redirect WHERE route=r AND subject_id=id ORDER BY sequence DESC LIMIT 1) THEN RETURN false; END IF;
 ELSE
  INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
    VALUES(r,id,coalesce(sequence_no,0)+1,destination,tid);
 END IF;
 INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
 VALUES(r,id,revision_no+1,'merge',release_digest,tid);
 UPDATE semantic.subject SET current_release=release_digest,projection_pending=true WHERE route=r AND subject_id=id;
 IF s.visibility='visible' AND previous=id AND destination<>id THEN
  UPDATE semantic.partition_subjects SET visible=visible-1 WHERE partition_no=r/16;
 ELSIF s.visibility='visible' AND previous<>id AND destination=id THEN
  UPDATE semantic.partition_subjects SET visible=visible+1 WHERE partition_no=r/16;
 END IF;
 RETURN true;
END; $$;


--
-- Name: bind_identity_source_consumer_terminal(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.bind_identity_source_consumer_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_receipt_key text;
BEGIN
 IF NEW.state NOT IN ('transferred','discharged') THEN RETURN NEW; END IF;
 SELECT r.receipt_key INTO v_receipt_key FROM semantic.identity_epoch_source_consumer_custody r
  WHERE r.partition_no=NEW.partition_no AND r.erasure_key=NEW.custody_key;
 UPDATE semantic.identity_epoch_receipt_binding b
  SET consumer_terminal_custody=NEW.custody_key,consumer_terminal_sequence=NEW.sequence
  WHERE b.partition_no=NEW.partition_no AND b.receipt_key=v_receipt_key
   AND b.consumer_terminal_custody IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity_consumer_terminal_binding_changed'; END IF;
 RETURN NEW;
END $$;


--
-- Name: capture_acceptance_current_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_acceptance_current_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'acceptance_current',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_acceptance_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_acceptance_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'acceptance',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_account_agent_moved_link_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_account_agent_moved_link_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'account_agent_moved_link',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.account_id,'subject','account_agent_moved_link',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;


--
-- Name: capture_account_agent_subject_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_account_agent_subject_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'account_agent_subject',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.account_id,'subject','account_agent_subject',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;


--
-- Name: capture_adoption_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_adoption_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'adoption',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_candidate_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_candidate_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'candidate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_context_directory_entry(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_context_directory_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 -- Reject delayed copies after the genuine local participant fence, for every inherited role.
 IF EXISTS(SELECT 1 FROM semantic.erasure_copy_role r
   JOIN semantic.erasure_home h ON h.partition_no=r.partition_no AND h.account_id=r.account_id
   WHERE r.partition_no=0 AND r.store='context_directory_entry' AND r.record_key=NEW.erasure_key
     AND r.transaction_id=NEW.recorded_transaction_id) THEN
   RAISE EXCEPTION 'context_directory_actor_fenced';
 END IF;
 PERFORM semantic.capture_erasure_roles(0,'context_directory_entry',NEW.erasure_key,NEW.recorded_transaction_id);
 RETURN NEW;
END; $$;


--
-- Name: capture_context_directory_source_record(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_context_directory_source_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.store='context_directory_entry' THEN
   SELECT true,context_id INTO NEW.native_present,NEW.context_id
     FROM semantic.context_directory_entry WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key;
   NEW.native_present:=coalesce(NEW.native_present,false);
 ELSIF NEW.store='context_directory_home' THEN
   SELECT true INTO NEW.native_present FROM semantic.context_directory_home
     WHERE route=NEW.partition_no*16 AND erasure_key=NEW.record_key;
   NEW.native_present:=coalesce(NEW.native_present,false);
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: capture_context_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_context_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_context_extension_activation_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_context_extension_activation_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context_extension_activation',NEW.erasure_key,native_tx);
 SELECT recorded_transaction_id INTO native_tx FROM semantic.context_extension WHERE route=NEW.route AND context_id=NEW.context_id AND digest=NEW.digest;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context_extension_activation',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_context_extension_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_context_extension_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'context_extension',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_copy_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_copy_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: capture_definition_activation_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_definition_activation_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'definition_activation',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_definition_release_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_definition_release_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'definition_release',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_erasure_roles(integer, text, bigint, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_erasure_roles(p_home integer, p_store text, p_key bigint, p_tx uuid) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE
 b record; provenance_key bigint; r record; native_position bigint; acting_human uuid;
 native_tx uuid:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 source_tx uuid; previous_account uuid; previous_role text;
 copies bigint:=0; sources bigint:=0; basis_count integer; requested_bytes integer;
 copy_identity text:=repeat('0',64); source_identity text:=repeat('0',64);
 expected_basis_locators integer; expected_basis_bytes integer;
 funded boolean:=current_setting('semantic.identity_receiving_capture',true)='on';
 budget semantic.identity_receiving_capture_pending;
BEGIN
 IF NOT coalesce(funded,false) OR p_store NOT IN ('identity_epoch_receiving_plan','identity_epoch_receiving_record',
    'identity_epoch_receiving_effect','identity_epoch_receiving_custody','identity_epoch_effect_receipt','identity_epoch_step') THEN
  PERFORM semantic.capture_erasure_roles_unfunded(p_home,p_store,p_key,p_tx);
  RETURN;
 END IF;
 IF funded THEN
  -- Consume one actual event in this DB transaction, not a caller-supplied count or cached proof.
  SELECT * INTO budget FROM semantic.identity_receiving_capture_pending
   WHERE transaction_xid=pg_current_xact_id()::text AND partition_no=p_home AND store=p_store AND record_key=p_key
   ORDER BY ordinal LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR NOT budget.armed OR budget.source_transaction_id IS DISTINCT FROM p_tx
     OR budget.native_transaction_id IS DISTINCT FROM native_tx THEN
   RAISE EXCEPTION 'identity_receiving_capture_unfunded_event' USING ERRCODE='23514';
  END IF;
  DELETE FROM semantic.identity_receiving_capture_pending
   WHERE transaction_xid=budget.transaction_xid AND ordinal=budget.ordinal;
 END IF;
 SELECT position INTO native_position FROM core.partition WHERE partition_no=p_home;

 -- Copy and source prefixes use the same two authentic origins. The counter is
 -- their complete aggregate, including repeated account/role pairs in each origin.
 FOREACH source_tx IN ARRAY ARRAY[p_tx,CASE WHEN native_tx IS DISTINCT FROM p_tx THEN native_tx ELSE NULL END] LOOP
  CONTINUE WHEN source_tx IS NULL;
  previous_account:=NULL; previous_role:=NULL;
  LOOP
   IF previous_account IS NULL THEN
    SELECT account_id,CASE WHEN octet_length(role)<=12 THEN CASE WHEN role IN ('actor','author','editor','acting-human','delegate','owner','subject','operator') THEN role END END AS role INTO r FROM semantic.erasure_copy_role
     WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=source_tx
     ORDER BY erasure_copy_role.account_id,erasure_copy_role.role LIMIT 1;
   ELSE
    SELECT account_id,CASE WHEN octet_length(role)<=12 THEN CASE WHEN role IN ('actor','author','editor','acting-human','delegate','owner','subject','operator') THEN role END END AS role INTO r FROM semantic.erasure_copy_role
     WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=source_tx
      AND (account_id,role)>(previous_account,previous_role) ORDER BY erasure_copy_role.account_id,erasure_copy_role.role LIMIT 1;
   END IF;
   EXIT WHEN NOT FOUND;
   copies:=copies+1;
   IF funded AND copies>budget.copy_roles THEN
    RAISE EXCEPTION 'identity_receiving_capture_copy_funding_changed' USING ERRCODE='23514';
   END IF;
   IF r.role IS NULL THEN
    RAISE EXCEPTION 'identity_receiving_capture_original_identity_changed' USING ERRCODE='23514';
   END IF;
   copy_identity:=encode(sha256(convert_to(copy_identity||'|copy|'||source_tx::text||'|'||r.account_id::text||'|'||r.role,'UTF8')),'hex');
   PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,source_tx,native_position);
   previous_account:=r.account_id; previous_role:=r.role;
  END LOOP;
 END LOOP;
 FOREACH source_tx IN ARRAY ARRAY[p_tx,CASE WHEN native_tx IS DISTINCT FROM p_tx THEN native_tx ELSE NULL END] LOOP
  CONTINUE WHEN source_tx IS NULL;
  previous_account:=NULL; previous_role:=NULL;
  LOOP
   IF previous_account IS NULL THEN
    SELECT account_id,CASE WHEN octet_length(role)<=12 THEN CASE WHEN role IN ('actor','author','editor','acting-human','delegate','owner','subject','operator') THEN role END END AS role INTO r FROM semantic.erasure_source_role
     WHERE partition_no=p_home AND transaction_id=source_tx ORDER BY erasure_source_role.account_id,erasure_source_role.role LIMIT 1;
   ELSE
    SELECT account_id,CASE WHEN octet_length(role)<=12 THEN CASE WHEN role IN ('actor','author','editor','acting-human','delegate','owner','subject','operator') THEN role END END AS role INTO r FROM semantic.erasure_source_role
     WHERE partition_no=p_home AND transaction_id=source_tx AND (account_id,role)>(previous_account,previous_role)
     ORDER BY erasure_source_role.account_id,erasure_source_role.role LIMIT 1;
   END IF;
   EXIT WHEN NOT FOUND;
   sources:=sources+1;
   IF funded AND sources>budget.source_roles THEN
    RAISE EXCEPTION 'identity_receiving_capture_source_funding_changed' USING ERRCODE='23514';
   END IF;
   IF r.role IS NULL THEN
    RAISE EXCEPTION 'identity_receiving_capture_original_identity_changed' USING ERRCODE='23514';
   END IF;
   source_identity:=encode(sha256(convert_to(source_identity||'|source|'||source_tx::text||'|'||r.account_id::text||'|'||r.role,'UTF8')),'hex');
   PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,source_tx,native_position);
   previous_account:=r.account_id; previous_role:=r.role;
  END LOOP;
 END LOOP;
 IF funded AND (copies<>budget.copy_roles OR sources<>budget.source_roles) THEN
  RAISE EXCEPTION 'identity_receiving_capture_original_roles_changed' USING ERRCODE='23514';
 END IF;
 IF copy_identity IS DISTINCT FROM budget.copy_identity OR source_identity IS DISTINCT FROM budget.source_identity THEN
  RAISE EXCEPTION 'identity_receiving_capture_original_identity_changed' USING ERRCODE='23514';
 END IF;
 -- Each authentic original/native write basis is read independently. Do not
 -- substitute the job's basis for the native command or return early when the
 -- original basis is absent. A shared transaction is visited exactly once.
 FOREACH source_tx IN ARRAY ARRAY[p_tx,CASE WHEN native_tx IS DISTINCT FROM p_tx THEN native_tx ELSE NULL END] LOOP
  CONTINUE WHEN source_tx IS NULL;
  expected_basis_locators:=CASE WHEN source_tx=p_tx THEN budget.basis_locators ELSE budget.native_basis_locators END;
  expected_basis_bytes:=CASE WHEN source_tx=p_tx THEN budget.basis_bytes ELSE budget.native_basis_bytes END;
  -- The delegation expression can match only this bounded ASCII length.
  SELECT principal_kind,principal_id,position,
   CASE WHEN octet_length(requested_by)=92 THEN requested_by ELSE NULL END AS requested_by
  INTO b FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=source_tx;
  IF NOT FOUND THEN
   IF expected_basis_locators IS NOT NULL OR expected_basis_bytes IS NOT NULL THEN
    RAISE EXCEPTION 'identity_receiving_capture_basis_changed' USING ERRCODE='23514';
   END IF;
   CONTINUE;
  END IF;
  requested_bytes:=coalesce(octet_length(b.requested_by),0);
  basis_count:=CASE WHEN b.principal_kind='account' THEN 2 ELSE 0 END
   + CASE WHEN b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN 3 ELSE 0 END;
  IF expected_basis_locators IS DISTINCT FROM basis_count OR expected_basis_bytes IS DISTINCT FROM requested_bytes THEN
   RAISE EXCEPTION 'identity_receiving_capture_basis_changed' USING ERRCODE='23514';
  END IF;
  INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,source_tx)
   ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
   RETURNING record_key INTO provenance_key;
  IF b.principal_kind='account' THEN
   PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor',p_store,p_key,source_tx,b.position);
   PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor','write_basis',provenance_key,source_tx,b.position);
  END IF;
  IF b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN
   acting_human:=split_part(b.requested_by,':',4)::uuid;
   PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human',p_store,p_key,source_tx,b.position);
   PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human','write_basis',provenance_key,source_tx,b.position);
   PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'delegate',p_store,p_key,source_tx,b.position);
  END IF;
 END LOOP;
END; $_$;


--
-- Name: capture_erasure_roles_unfunded(integer, text, bigint, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_erasure_roles_unfunded(p_home integer, p_store text, p_key bigint, p_tx uuid) RETURNS void
    LANGUAGE plpgsql
    AS $_$
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
END; $_$;


--
-- Name: capture_erasure_source_record(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_erasure_source_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
 WHEN 'identity_epoch_prearm_bridge' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_inverse' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_inverse WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_directory' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_directory WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_page' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_page WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_disposition' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_disposition WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_custody' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_custody WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_claim' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_claim WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'identity_epoch_prearm_decision' THEN SELECT true INTO v_present FROM semantic.identity_epoch_prearm_decision WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'record_source_set' THEN SELECT true INTO v_present FROM semantic.record_source_set WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
 WHEN 'record_source_set_member' THEN SELECT true,subject_id,candidate_id INTO v_present,v_original,v_candidate FROM semantic.record_source_set_member WHERE partition_no=NEW.partition_no AND erasure_key=NEW.record_key;
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


--
-- Name: capture_erasure_source_removal(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_erasure_source_removal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: capture_external_claim_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_external_claim_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'external_claim',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_fact_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_fact_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'fact',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_hidden_candidate_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_hidden_candidate_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.moderation WHERE route=NEW.route AND subject_id=NEW.subject_id AND security_revision=NEW.security_revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'hidden_candidate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_ack_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_ack_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_ack',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_admission_attempt_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_admission_attempt_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_admission_attempt',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_admission_plan_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_admission_plan_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_admission_plan',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_admission_receipt_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_admission_receipt_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_admission_receipt',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_admission_source_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_admission_source_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'identity_epoch_admission_source',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_change_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_change_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_change',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_effect_receipt_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_effect_receipt_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_effect_receipt',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_home_gate_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_home_gate_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'identity_epoch_home_gate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_input_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_input_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_input',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_job_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_job_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_job',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_key(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_key(r integer, id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE owned boolean;
BEGIN
 PERFORM semantic.guard_identity_terminal_closure_key(r,id);
 PERFORM 1 FROM semantic.identity_epoch_dirty WHERE route=r AND original=id FOR UPDATE;
 owned:=semantic.identity_epoch_mapping_owns(r,id);
 IF (EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold
       WHERE partition_no=r/16 AND route=r AND original=id AND NOT closed)
     OR EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence WHERE route=r AND destination=id)) AND NOT owned
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES(r,id)
 ON CONFLICT(route,original) DO UPDATE SET revision=semantic.identity_epoch_dirty.revision+1;
 IF owned THEN
   UPDATE semantic.identity_epoch_dirty SET captured_revision=revision WHERE route=r AND original=id;
   RETURN;
 END IF;
 UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,
   sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=r/16;
 UPDATE semantic.identity_epoch_group SET ready=false,version=version+1
   WHERE partition_no=r/16 AND terminal=id AND pending_job IS NULL;
END; $$;


--
-- Name: capture_identity_epoch_mapping_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_mapping_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'identity_epoch_mapping',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_mapping_state_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;home integer;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 IF native_tx IS NULL THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_TABLE_NAME='identity_epoch_mapping_fence' THEN home:=NEW.route/16; ELSE home:=NEW.partition_no; END IF;
 PERFORM semantic.capture_erasure_roles(home,TG_TABLE_NAME,NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_epoch_source(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME='merge_member' THEN
    IF TG_OP='UPDATE' AND (OLD.route,OLD.subject_id,OLD.member_id)=(NEW.route,NEW.subject_id,NEW.member_id) THEN RETURN NEW; END IF;
    IF TG_OP IN ('UPDATE','DELETE') THEN
      INSERT INTO semantic.identity_epoch_member_dirty(route,terminal,original) VALUES(OLD.route,OLD.subject_id,OLD.member_id)
      ON CONFLICT(route,terminal,original) DO UPDATE SET revision=semantic.identity_epoch_member_dirty.revision+1;
      PERFORM semantic.capture_identity_epoch_key(OLD.route,OLD.subject_id);
    END IF;
    IF TG_OP IN ('UPDATE','INSERT') THEN
      INSERT INTO semantic.identity_epoch_member_dirty(route,terminal,original) VALUES(NEW.route,NEW.subject_id,NEW.member_id)
      ON CONFLICT(route,terminal,original) DO UPDATE SET revision=semantic.identity_epoch_member_dirty.revision+1;
      PERFORM semantic.capture_identity_epoch_key(NEW.route,NEW.subject_id);
    END IF;
  ELSE
    IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM semantic.capture_identity_epoch_key(OLD.route,OLD.subject_id); END IF;
    IF TG_OP IN ('UPDATE','INSERT') THEN PERFORM semantic.capture_identity_epoch_key(NEW.route,NEW.subject_id); END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;


--
-- Name: capture_identity_epoch_step_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_step_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,'identity_epoch_step',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_prearm_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_prearm_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=coalesce((to_jsonb(NEW)->>'transaction_id')::uuid,
   nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid);
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_public_writer(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_public_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE h integer; v bigint; o uuid;
BEGIN
 IF TG_OP='DELETE' THEN h:=OLD.route>>4; o:=OLD.subject_id;
 ELSE h:=NEW.route>>4; o:=NEW.subject_id; END IF;
 INSERT INTO semantic.identity_public_writer(partition_no) VALUES(h)
 ON CONFLICT(partition_no) DO UPDATE SET revision=semantic.identity_public_writer.revision+1
 RETURNING revision INTO v;
 INSERT INTO semantic.identity_public_dirty VALUES(h,o,v)
 ON CONFLICT(partition_no,original) DO UPDATE SET revision=excluded.revision;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;


--
-- Name: capture_identity_receiving_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_receiving_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 RETURN NEW;
END; $$;


--
-- Name: capture_identity_source_consumer_custody_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_source_consumer_custody_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 RETURN NEW;
END; $$;


--
-- Name: capture_inbound_link_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_inbound_link_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'inbound_link',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_moderation_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_moderation_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'moderation',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.actor,'operator','moderation',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;


--
-- Name: capture_outbound_link_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_outbound_link_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'outbound_link',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_provider_review_queue_key(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_provider_review_queue_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid; k bigint; p bigint;
BEGIN
  IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
  SELECT r.recorded_transaction_id INTO native_tx FROM semantic.candidate c
    JOIN semantic.revision r USING(route,subject_id,revision)
    WHERE c.route=NEW.route AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id;
  IF native_tx IS NULL THEN RAISE EXCEPTION 'Provider candidate has no native provenance'; END IF;
  SELECT position INTO p FROM core.partition WHERE partition_no=NEW.route/16;
  INSERT INTO semantic.provider_review_queue_key(route,source,subject_id,candidate_id,recorded_transaction_id,captured_position)
    VALUES(NEW.route,NEW.source,NEW.subject_id,NEW.candidate_id,native_tx,p)
    ON CONFLICT(route,source,subject_id,candidate_id) DO NOTHING;
  SELECT erasure_key INTO k FROM semantic.provider_review_queue_key
    WHERE route=NEW.route AND source=NEW.source AND subject_id=NEW.subject_id AND candidate_id=NEW.candidate_id;
  PERFORM semantic.capture_provider_review_queue_roles(NEW.route,k,NEW.subject_id,NEW.candidate_id,native_tx);
  RETURN NEW;
END; $$;


--
-- Name: capture_provider_review_queue_roles(integer, bigint, uuid, uuid, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_provider_review_queue_roles(p_route integer, p_key bigint, p_subject uuid, p_candidate uuid, p_tx uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE r record; n integer:=0;
BEGIN
  FOR r IN SELECT l.account_id,l.role FROM semantic.candidate c
    JOIN semantic.erasure_locator l ON l.partition_no=p_route/16 AND l.store='candidate' AND l.record_key=c.erasure_key
    WHERE c.route=p_route AND c.subject_id=p_subject AND c.candidate_id=p_candidate
    ORDER BY l.account_id,l.role LIMIT 9 LOOP
    n:=n+1;
    IF n>8 THEN RAISE EXCEPTION 'Provider candidate role bound exceeded'; END IF;
    INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
      VALUES(p_route/16,'provider_review_queue_key',p_key,p_tx,r.account_id,r.role) ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM semantic.capture_erasure_roles(p_route/16,'provider_review_queue_key',p_key,p_tx);
END; $$;


--
-- Name: capture_record_retention(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_record_retention() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: capture_record_source_set_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_record_source_set_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE source_row record; role_row record; native_route integer;
BEGIN
 PERFORM semantic.capture_erasure_roles(NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 IF TG_TABLE_NAME='record_source_set_member' THEN
  native_route:=(get_byte(uuid_send(NEW.subject_id),10)*256+get_byte(uuid_send(NEW.subject_id),11));
  FOR source_row IN
   SELECT 'candidate' store,c.erasure_key FROM semantic.candidate c WHERE c.route=native_route
    AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id AND c.revision=NEW.source_revision
   UNION ALL
   SELECT 'fact',f.erasure_key FROM semantic.fact f JOIN semantic.revision r
    ON r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
   WHERE f.route=native_route AND f.subject_id=NEW.subject_id AND r.revision=NEW.source_revision
    AND ((NEW.kind='contribution' AND f.statement_id=NEW.candidate_id) OR
      (NEW.kind='terms' AND f.language=NEW.language AND f.kind=CASE NEW.field
        WHEN 'labels' THEN 'label' WHEN 'descriptions' THEN 'description' ELSE 'alias' END))
  LOOP
   FOR role_row IN SELECT account_id,role FROM semantic.erasure_locator WHERE partition_no=NEW.partition_no
    AND store=source_row.store AND record_key=source_row.erasure_key LOOP
    PERFORM semantic.record_erasure_locator(NEW.partition_no,role_row.account_id,role_row.role,
      TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id,NULL);
   END LOOP;
  END LOOP;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: capture_redirect_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_redirect_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'redirect',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_release_composite_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_release_composite_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 SELECT recorded_transaction_id INTO native_tx FROM semantic.context_extension
 WHERE route=NEW.extension_route AND context_id=NEW.extension_context_id AND digest=NEW.extension_digest;
 PERFORM semantic.capture_erasure_roles(NEW.extension_route/16,'release_composite',NEW.erasure_key,native_tx);
 RETURN NEW;
END; $$;


--
-- Name: capture_resource_role_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_resource_role_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: capture_retraction_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_retraction_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT recorded_transaction_id FROM semantic.revision WHERE route=NEW.route AND subject_id=NEW.subject_id AND revision=NEW.revision);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'retraction',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_revision_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_revision_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'revision',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_source_candidate_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_source_candidate_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT r.recorded_transaction_id FROM semantic.candidate c JOIN semantic.revision r USING(route,subject_id,revision) WHERE c.route=NEW.route AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'source_candidate',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_statement_disclosure_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_statement_disclosure_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=(SELECT r.recorded_transaction_id FROM semantic.candidate c JOIN semantic.revision r USING(route,subject_id,revision) WHERE c.route=NEW.route AND c.subject_id=NEW.subject_id AND c.candidate_id=NEW.candidate_id);
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'statement_disclosure',NEW.erasure_key,native_tx);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.account_id,'subject','statement_disclosure',NEW.erasure_key,native_tx,NULL);
 RETURN NEW;
END; $$;


--
-- Name: capture_subject_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_subject_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE native_tx uuid;
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 native_tx:=NEW.recorded_transaction_id;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'subject',NEW.erasure_key,native_tx);
 
 RETURN NEW;
END; $$;


--
-- Name: capture_term_head(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_term_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.kind='statement' THEN RETURN NEW; END IF;
 INSERT INTO semantic.term_head(route,subject_id,kind,language,slot_id,first_seq,support_transaction_id)
 VALUES(NEW.route,NEW.subject_id,NEW.kind,NEW.language,NEW.slot_id,
   CASE WHEN NEW.kind='alias' THEN 1 ELSE NEW.log_seq END,NEW.recorded_transaction_id)
 ON CONFLICT(route,subject_id,kind,language) DO UPDATE
 SET slot_id=EXCLUDED.slot_id,first_seq=EXCLUDED.first_seq,active=true
 WHERE term_head.slot_id=EXCLUDED.slot_id OR EXISTS (
   SELECT 1 FROM semantic.revision r WHERE r.route=NEW.route AND r.subject_id=NEW.subject_id
     AND r.recorded_transaction_id=NEW.recorded_transaction_id AND r.kind='identity');
 RETURN NEW;
END; $$;


--
-- Name: capture_zone_erasure(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_zone_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 PERFORM semantic.capture_erasure_roles(NEW.route/16,'zone',NEW.erasure_key,NEW.transaction_id);
 PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.owner_id,'owner','zone',NEW.erasure_key,NEW.transaction_id,NULL);
 RETURN NEW;
END; $$;


--
-- Name: catalogue_work_valid(bigint[], bigint[]); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.catalogue_work_valid(admitted bigint[], spent bigint[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
 SELECT array_ndims(admitted)=1 AND array_lower(admitted,1)=1 AND array_length(admitted,1)=8
 AND array_ndims(spent)=1 AND array_lower(spent,1)=1 AND array_length(spent,1)=8
 AND NOT EXISTS (SELECT 1 FROM generate_series(1,8) n
  WHERE admitted[n] IS NULL OR spent[n] IS NULL OR spent[n]<0 OR admitted[n]<spent[n]
   OR admitted[n]>9007199254740991)
$$;


--
-- Name: close_identity_epoch_admission(integer, uuid, bigint, text); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.close_identity_epoch_admission(p_home integer, p_job uuid, p_epoch bigint, p_scope text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE a semantic.identity_epoch_admission_attempt;
BEGIN
 PERFORM 1 FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
 SELECT * INTO a FROM semantic.identity_epoch_admission_attempt WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
 IF FOUND AND (a.job_epoch<>p_epoch OR a.scope_digest<>p_scope) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 INSERT INTO semantic.identity_epoch_admission_attempt(partition_no,job_id,job_epoch,scope_digest,state)
 VALUES(p_home,p_job,p_epoch,p_scope,'closed') ON CONFLICT(partition_no,job_id) DO UPDATE SET state='closed';
END; $$;


--
-- Name: commit_record_source_set(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.commit_record_source_set() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE saved semantic.record_source_set;
BEGIN
 SELECT * INTO STRICT saved FROM semantic.record_source_set
  WHERE partition_no=NEW.partition_no AND transaction_id=NEW.transaction_id;
 IF NOT saved.sealed OR saved.native_xid<>pg_current_xact_id()::text OR NOT EXISTS(
  SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=saved.partition_no AND b.transaction_id=saved.transaction_id
    AND b.xmin=pg_current_xact_id()::xid) THEN
  RAISE EXCEPTION 'Semantic record source set requires a sealed native current command' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: context_directory_dirty(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.context_directory_dirty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.labels IS DISTINCT FROM OLD.labels OR NEW.state IS DISTINCT FROM OLD.state)
    AND NEW.security_revision=OLD.security_revision THEN
   NEW.security_revision:=OLD.security_revision+1;
 END IF;
 IF TG_OP='INSERT' OR NEW.labels IS DISTINCT FROM OLD.labels OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.security_revision IS DISTINCT FROM OLD.security_revision
    OR (NEW.directory_pending AND NOT OLD.directory_pending) THEN
   NEW.directory_pending:=true;
   UPDATE semantic.context_directory_home SET complete=false,after_route=least(after_route,NEW.route),after_key=0
     WHERE route=(NEW.route/16)*16;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: context_directory_invalidate_home(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.context_directory_invalidate_home() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.write_state IS DISTINCT FROM OLD.write_state THEN
   UPDATE semantic.context_directory_home SET complete=false,source_epoch=NEW.epoch,
     after_route=NEW.partition_no*16,after_key=0 WHERE route=NEW.partition_no*16;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: context_directory_owner_dirty(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.context_directory_owner_dirty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; id uuid; role text;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD.route; id:=OLD.resource_id; role:=OLD.grant_role;
 ELSE r:=NEW.route; id:=NEW.resource_id; role:=NEW.grant_role; END IF;
 IF role='semantic.context.owner' THEN
   UPDATE semantic.context SET directory_pending=true,security_revision=security_revision+1 WHERE route=r AND context_id=id;
 END IF;
 RETURN NULL;
END; $$;


--
-- Name: context_extension_head(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.context_extension_head(p_route integer, p_context_id uuid) RETURNS TABLE(digest text, head integer)
    LANGUAGE sql STABLE
    SET enable_seqscan TO 'off'
    AS $$
  SELECT activation.digest, activation.head
  FROM semantic.context_extension_activation activation
  WHERE activation.route = p_route AND activation.context_id = p_context_id
  ORDER BY activation.head DESC
  LIMIT 1
$$;


--
-- Name: enqueue_account_public_filter(integer, bigint, bigint); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.enqueue_account_public_filter(home integer, account_revision bigint, claim_revision bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE owner integer;
BEGIN
  SELECT epoch INTO owner FROM core.partition
    WHERE partition_no=home AND write_state='active';
  IF owner IS NULL THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
  PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=home FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
  INSERT INTO semantic.public_filter_privacy_pending
    (partition_no,input_key,owner_epoch,first_position,through_position,enqueue_revision,
     native_revision,native_claim_revision,native_transaction)
  VALUES (home,'["domain","accounts"]',owner,NULL,NULL,1,
    account_revision,claim_revision,pg_current_xact_id())
  ON CONFLICT (partition_no,input_key) DO UPDATE SET
    owner_epoch=EXCLUDED.owner_epoch,
    enqueue_revision=semantic.public_filter_privacy_pending.enqueue_revision+1,
    native_revision=EXCLUDED.native_revision,
    native_claim_revision=EXCLUDED.native_claim_revision,
    native_transaction=EXCLUDED.native_transaction,
    live=true;
END $$;


--
-- Name: enqueue_identity_receiving_capture(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.enqueue_identity_receiving_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF current_setting('semantic.identity_receiving_capture',true) IS DISTINCT FROM 'on'
    OR current_setting('semantic.erasure_cleanup',true)='on' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME IN ('identity_epoch_effect_receipt','identity_epoch_step') THEN
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,job_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.job_id);
 ELSE
  INSERT INTO semantic.identity_receiving_capture_pending(transaction_xid,partition_no,store,record_key,source_transaction_id)
   VALUES(pg_current_xact_id()::text,NEW.partition_no,TG_TABLE_NAME,NEW.erasure_key,NEW.transaction_id);
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: enroll_context_role_provenance(integer, bigint, uuid, uuid, uuid, text, text, text, uuid, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.enroll_context_role_provenance(p_route integer, p_occurrence bigint, p_resource_id uuid, p_original_creator uuid, p_account_id uuid, p_grant_role text, p_valid text, p_side text, p_grant_transaction uuid, p_source_transaction uuid) RETURNS TABLE(state text, context_key bigint)
    LANGUAGE plpgsql
    AS $$
DECLARE c semantic.context; native_tx uuid; native_epoch integer; native_position bigint; original_position bigint;
 party record; existing semantic.context_role_enrollment;
BEGIN
 IF p_route IS NULL OR p_route NOT BETWEEN 0 AND 65535 OR p_occurrence IS NULL OR p_occurrence<=0
 OR p_resource_id IS NULL OR p_source_transaction IS NULL
 OR (get_byte(uuid_send(p_resource_id),10)*256+get_byte(uuid_send(p_resource_id),11))<>p_route THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 -- Lock the actual Source key, including deleted-but-retained Contexts. Missing/purged is unresolved.
 SELECT * INTO c FROM semantic.context WHERE route=p_route AND context_id=p_resource_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN; END IF;
 -- Global has an explicit native no-personal-payload policy. Absence never establishes this policy.
 IF c.kind='global' THEN RETURN QUERY SELECT 'not-applicable'::text,NULL::bigint; RETURN; END IF;
 IF p_original_creator IS NULL OR p_account_id IS NULL
 OR p_original_creator IN ('00000000-0000-0000-0000-000000000000','00000000-0000-8000-8000-000000000001')
 OR p_account_id IN ('00000000-0000-0000-0000-000000000000','00000000-0000-8000-8000-000000000001')
 OR NOT coalesce((p_side='creator' AND p_account_id=p_original_creator AND p_grant_role=''
       AND p_grant_transaction IS NULL AND p_valid IS NULL)
    OR (p_side IN ('new','former') AND p_grant_role='semantic.context.owner'
       AND p_grant_transaction IS NOT NULL AND p_valid IS NOT NULL),false) THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 -- The original deferred Access trigger already has a native basis. The TS command-body port
 -- may instead have its actual Source commit, constrained to the executor's forthcoming fence.
 SELECT b.transaction_id,b.epoch,b.position INTO native_tx,native_epoch,native_position
 FROM core.partition p JOIN editorial.write_basis b ON b.partition_no=p.partition_no AND b.position=p.position
 WHERE p.partition_no=p_route/16 AND p.write_state='active' AND p.epoch=b.epoch
   AND b.xmin::text=pg_current_xact_id()::text FOR UPDATE OF p;
 IF NOT FOUND THEN
  SELECT s.transaction_id,s.epoch,s.position INTO native_tx,native_epoch,native_position
  FROM core.partition p JOIN semantic.erasure_source_commit s ON s.partition_no=p.partition_no
    AND s.epoch=p.epoch AND s.position=p.position+1
  WHERE p.partition_no=p_route/16 AND p.write_state='active'
    AND s.xmin::text=pg_current_xact_id()::text FOR UPDATE OF p;
 END IF;
 IF native_tx IS NULL OR NOT (p_source_transaction=native_tx OR EXISTS(
   SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=p_route/16 AND b.transaction_id=p_source_transaction))
 OR (p_grant_transaction IS NOT NULL AND p_grant_transaction<>native_tx AND NOT EXISTS(
   SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=p_route/16 AND b.transaction_id=p_grant_transaction)) THEN
  RETURN QUERY SELECT 'pending'::text,NULL::bigint; RETURN;
 END IF;
 SELECT b.position INTO original_position FROM editorial.write_basis b
 WHERE b.partition_no=p_route/16 AND b.transaction_id=p_source_transaction;
 original_position:=coalesce(original_position,native_position);
 SELECT * INTO existing FROM semantic.context_role_enrollment WHERE route=p_route AND occurrence=p_occurrence;
 IF FOUND THEN
  IF existing.context_key=c.erasure_key AND existing.side=p_side
    AND existing.source_transaction=p_source_transaction
    AND existing.grant_transaction IS NOT DISTINCT FROM p_grant_transaction THEN
   RETURN QUERY SELECT 'enrolled'::text,c.erasure_key;
  ELSE RETURN QUERY SELECT 'pending'::text,NULL::bigint;
  END IF;
  RETURN;
 END IF;
 -- The native command gate serializes Source sealing and late admission. Only these exact
 -- parties/keys reopen; the ordinary locator relay owns account-home late-item registration.
 FOR party IN SELECT p_original_creator AS account_id,'author'::text AS role
   UNION SELECT p_account_id,'owner'::text WHERE p_side IN ('new','former') ORDER BY account_id,role LOOP
  DELETE FROM semantic.erasure_source_seal WHERE partition_no=p_route/16 AND account_id=party.account_id;
  PERFORM semantic.record_erasure_locator(p_route/16,party.account_id,party.role,'context',c.erasure_key,
    p_source_transaction,original_position);
  UPDATE semantic.erasure_locator SET state='pending'
   WHERE partition_no=p_route/16 AND account_id=party.account_id AND role=party.role
     AND store='context' AND record_key=c.erasure_key;
  UPDATE semantic.erasure_home SET state='local' WHERE partition_no=p_route/16 AND account_id=party.account_id;
 END LOOP;
 INSERT INTO semantic.context_role_enrollment(route,occurrence,context_key,side,grant_transaction,source_transaction,
   enrollment_transaction,epoch,position)
 VALUES(p_route,p_occurrence,c.erasure_key,p_side,p_grant_transaction,p_source_transaction,native_tx,native_epoch,native_position);
 RETURN QUERY SELECT 'enrolled'::text,c.erasure_key;
END; $$;


--
-- Name: enroll_public_output_consumer(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.enroll_public_output_consumer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_WHEN='BEFORE' THEN
  PERFORM 1 FROM semantic.identity_public_output_gate WHERE partition_no=NEW.partition_no
   AND capture_id=NEW.capture_id AND state='open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'public_output_consumer_fenced'; END IF;
 ELSE
  UPDATE semantic.identity_public_output_gate SET enrolled_count=enrolled_count+1
   WHERE partition_no=NEW.partition_no AND capture_id=NEW.capture_id AND state='open';
  IF NOT FOUND THEN RAISE EXCEPTION 'public_output_consumer_fenced'; END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: erasure_mutation_allowed(text, integer, bigint); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.erasure_mutation_allowed(p_store text, p_route integer, p_key bigint) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT current_setting('semantic.erasure_cleanup',true)='on' AND EXISTS (
 SELECT 1 FROM semantic.erasure_locator l JOIN semantic.erasure_home h USING(partition_no,account_id)
 WHERE l.partition_no=p_route/16 AND l.account_id=nullif(current_setting('semantic.erasure_account',true),'')::uuid
 AND l.store=p_store AND l.record_key=p_key AND l.state='pending' AND h.state='local')
$$;


--
-- Name: export_identity_epoch_empty_bootstrap(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.export_identity_epoch_empty_bootstrap(p_home integer, p_tx uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE owner record;
BEGIN
  IF EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_home WHERE partition_no=p_home)
    OR EXISTS (SELECT 1 FROM semantic.subject WHERE route BETWEEN p_home*16 AND p_home*16+15)
    OR EXISTS (SELECT 1 FROM semantic.revision WHERE route BETWEEN p_home*16 AND p_home*16+15)
    OR EXISTS (SELECT 1 FROM semantic.redirect WHERE route BETWEEN p_home*16 AND p_home*16+15)
    OR EXISTS (SELECT 1 FROM semantic.account_agent_subject WHERE route BETWEEN p_home*16 AND p_home*16+15)
    OR EXISTS (SELECT 1 FROM semantic.merge_member WHERE route BETWEEN p_home*16 AND p_home*16+15)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_dirty WHERE route BETWEEN p_home*16 AND p_home*16+15)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_member_dirty WHERE route BETWEEN p_home*16 AND p_home*16+15)
    THEN RETURN false; END IF;
  SELECT * INTO owner FROM core.partition WHERE partition_no=p_home AND write_state='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  INSERT INTO semantic.identity_epoch_bootstrap_home
    (partition_no,phase,after_route,after_original,after_member,generation,owner_epoch)
    VALUES(p_home,'dirty',p_home*16-1,'00000000-0000-0000-0000-000000000000',
      '00000000-0000-0000-0000-000000000000',1,owner.epoch) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position,purpose)
    VALUES(p_home,p_tx,owner.epoch,owner.position+1,'bootstrap');
  INSERT INTO semantic.identity_epoch_bootstrap_page(partition_no,transaction_id,generation,phase,caught_up)
    VALUES(p_home,p_tx,1,'member-dirty',true);
  RETURN true;
END; $$;


--
-- Name: fence_kind_type_anchor(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.fence_kind_type_anchor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO semantic.kind_type_anchor_fence(route, subject_id, version)
      VALUES (OLD.route, OLD.subject_id, 1)
      ON CONFLICT (route, subject_id) DO UPDATE
      SET version = semantic.kind_type_anchor_fence.version + 1;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      (NEW.route, NEW.subject_id) IS DISTINCT FROM (OLD.route, OLD.subject_id)) THEN
    INSERT INTO semantic.kind_type_anchor_fence(route, subject_id, version)
      VALUES (NEW.route, NEW.subject_id, 1)
      ON CONFLICT (route, subject_id) DO UPDATE
      SET version = semantic.kind_type_anchor_fence.version + 1;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fence_public_filter_population(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.fence_public_filter_population() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.epoch,NEW.write_state) IS DISTINCT FROM (OLD.epoch,OLD.write_state) THEN
    UPDATE semantic.public_filter_privacy_head SET population_fenced=true
      WHERE partition_no=OLD.partition_no;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_identity_epoch_birth(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_epoch_birth() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM semantic.revision r
    JOIN semantic.subject s ON (s.route,s.subject_id)=(r.route,r.subject_id)
    JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(r.route,r.subject_id)
    JOIN semantic.identity_epoch_home_gate g ON (g.route,g.destination,g.original)=(r.route,r.subject_id,r.subject_id)
    JOIN core.partition p ON p.partition_no=r.route/16
    WHERE r.route=NEW.route AND r.subject_id=NEW.subject_id AND r.revision=1 AND r.kind='create'
      AND r.xmin=pg_current_xact_id()::xid AND s.xmin=pg_current_xact_id()::xid
      AND m.xmin=pg_current_xact_id()::xid AND g.xmin=pg_current_xact_id()::xid
      AND r.recorded_transaction_id=NEW.recorded_transaction_id
      AND m.recorded_transaction_id=r.recorded_transaction_id AND g.recorded_transaction_id=r.recorded_transaction_id
      AND m.origin='creation' AND m.terminal=r.subject_id AND m.control_group=r.subject_id
      AND m.control_partition=r.route/16 AND m.owner_epoch=p.epoch AND p.write_state='active'
      AND m.epoch>0 AND g.epoch=m.epoch AND g.terminal=r.subject_id
      AND g.pending_job IS NULL AND g.pending_epoch IS NULL
  ) THEN RAISE EXCEPTION 'identity_epoch_birth_custody_required'; END IF;
  RETURN NEW;
END; $$;


--
-- Name: guard_identity_epoch_mapping_links(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_epoch_mapping_links() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; id uuid;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD.route;id:=OLD.subject_id; ELSE r:=NEW.route;id:=NEW.subject_id; END IF;
 -- The subject lock orders a writer predating the fence with the first fence.
 PERFORM 1 FROM semantic.subject WHERE route=r AND subject_id=id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence WHERE route=r AND destination=id)
   AND NOT semantic.identity_epoch_mapping_owns(r,id)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;


--
-- Name: guard_identity_prearm_group(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_prearm_group() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b semantic.identity_epoch_prearm_bridge;
BEGIN
 SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=OLD.partition_no AND generation=OLD.generation FOR UPDATE;
 IF FOUND AND b.job_id IS NOT NULL AND (TG_OP='DELETE' OR
 (NEW.partition_no,NEW.terminal,NEW.generation,NEW.version,NEW.owner_epoch,NEW.observed_count) IS DISTINCT FROM
 (OLD.partition_no,OLD.terminal,OLD.generation,OLD.version,OLD.owner_epoch,OLD.observed_count))
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_attempt a WHERE a.partition_no=OLD.partition_no
 AND a.job_id=b.job_id AND a.job_epoch=b.job_epoch AND a.state='acquired'
 AND current_setting('semantic.identity_prearm_effect_job',true)=b.job_id::text)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_identity_prearm_inverse(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_prearm_inverse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b semantic.identity_epoch_prearm_bridge;
BEGIN
 SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge
 WHERE partition_no=coalesce(NEW.partition_no,OLD.partition_no) AND generation=coalesce(NEW.generation,OLD.generation) FOR UPDATE;
 IF NOT FOUND OR b.job_id IS NOT NULL THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_original m
 JOIN semantic.identity_epoch_group g ON g.partition_no=m.partition_no AND g.generation=m.generation
 JOIN core.partition p ON p.partition_no=g.partition_no AND p.epoch=g.owner_epoch AND p.write_state='active'
 WHERE m.partition_no=NEW.partition_no AND m.generation=NEW.generation AND m.original=NEW.original
 AND g.terminal=b.terminal AND g.version=b.basis_version AND g.pending_job IS NULL)
 THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_identity_prearm_membership(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_prearm_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b semantic.identity_epoch_prearm_bridge;g uuid;h integer;
BEGIN
 g:=coalesce(NEW.generation,OLD.generation);h:=coalesce(NEW.partition_no,OLD.partition_no);
 SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=h AND generation=g FOR UPDATE;
 IF FOUND AND b.job_id IS NOT NULL
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='UPDATE' AND (NEW.partition_no,NEW.generation) IS DISTINCT FROM (OLD.partition_no,OLD.generation) THEN
  SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=OLD.partition_no AND generation=OLD.generation FOR UPDATE;
  IF FOUND AND b.job_id IS NOT NULL
  THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_identity_prearm_owner(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_prearm_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.node,NEW.epoch,NEW.write_state,NEW.moved_to)
   IS NOT DISTINCT FROM (OLD.node,OLD.epoch,OLD.write_state,OLD.moved_to) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_control WHERE partition_no=OLD.partition_no AND prepare_job IS NOT NULL)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold WHERE partition_no=OLD.partition_no AND NOT closed)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row WHERE partition_no=OLD.partition_no)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping WHERE route BETWEEN OLD.partition_no*16 AND OLD.partition_no*16+15
   AND (closure_state<>'legacy' OR closure_successor_ticket IS NOT NULL))
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_group WHERE partition_no=OLD.partition_no AND closure_claim IS NOT NULL)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_identity_prearm_page(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_prearm_page() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND semantic.erasure_mutation_allowed(TG_TABLE_NAME,OLD.partition_no*16,OLD.erasure_key)
 AND NEW.scope='{}'::jsonb AND NEW.capture_id='' AND
 (to_jsonb(NEW)-ARRAY['scope','capture_id'])=(to_jsonb(OLD)-ARRAY['scope','capture_id'])
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Immutable identity pre-arm page';
END; $$;


--
-- Name: guard_identity_scope_claim(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_scope_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b semantic.identity_scope_bridge;
BEGIN
 IF NEW.pending_job IS NULL OR (NEW.pending_job,NEW.pending_epoch) IS NOT DISTINCT FROM
 (OLD.pending_job,OLD.pending_epoch) THEN RETURN NEW; END IF;
 INSERT INTO semantic.identity_scope_bridge(partition_no,generation)
 VALUES(NEW.partition_no,'00000000-0000-0000-0000-000000000000') ON CONFLICT DO NOTHING;
 FOR b IN SELECT * FROM semantic.identity_scope_bridge
 WHERE partition_no=NEW.partition_no AND generation IN
 (NEW.generation,'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY generation FOR UPDATE LOOP
  -- Advance even an empty prefix: later enrollment cannot miss a committed prior claim
  -- through a SERIALIZABLE snapshot taken before this bridge lock was available.
  UPDATE semantic.identity_scope_bridge SET version=version+1
  WHERE partition_no=b.partition_no AND generation=b.generation;
  IF NOT EXISTS(SELECT 1 FROM semantic.identity_scope_inverse i WHERE i.partition_no=b.partition_no AND i.generation=b.generation LIMIT 1) THEN CONTINUE; END IF;
  IF b.generation=NEW.generation THEN
   -- The delivered admission producer sealed this exact native inverse generation.
   -- Its bounded export already resolved every Source PREPARATION receipt.
   IF NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_prearm_directory d
    JOIN semantic.identity_epoch_prearm_bridge n USING(partition_no,generation)
    JOIN semantic.identity_epoch_native_commit c ON c.partition_no=d.partition_no
     AND c.transaction_id=d.sealed_transaction_id AND c.xmin=d.xmin AND c.purpose='identity-prearm'
    JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch
     AND p.position>=c.position AND p.write_state='active' AND p.moved_to IS NULL
    WHERE d.partition_no=NEW.partition_no AND d.generation=NEW.generation
     AND d.job_id=NEW.pending_job AND d.job_epoch=NEW.pending_epoch AND NOT d.released
     AND d.exhausted AND d.owner_epoch=NEW.owner_epoch AND d.basis_version=OLD.version
     AND n.job_id=d.job_id AND n.job_epoch=d.job_epoch AND n.scope_digest=d.scope_digest
     AND n.owner_epoch=d.owner_epoch AND n.basis_version=d.basis_version)
   THEN RAISE EXCEPTION 'identity_scope_prearm_required' USING ERRCODE='40001'; END IF;
  ELSIF b.closed_job IS DISTINCT FROM NEW.pending_job OR b.closed_epoch IS DISTINCT FROM NEW.pending_epoch
   OR b.seal_transaction IS NULL THEN
   RAISE EXCEPTION 'identity_scope_prearm_required' USING ERRCODE='40001';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;


--
-- Name: guard_identity_scope_consumer_writer(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_scope_consumer_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record; old_key jsonb; new_key jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN old_key:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_key:=to_jsonb(NEW); END IF;
 FOR r IN SELECT DISTINCT (v->>'partition_no')::integer AS partition_no,
   v->>'source_key' AS source_key,v->>'scope_id' AS scope_id
  FROM (VALUES(old_key),(new_key)) keys(v) WHERE v IS NOT NULL
  ORDER BY partition_no,source_key,scope_id LOOP
  PERFORM 1 FROM semantic.identity_scope_summary s
   WHERE (s.partition_no,s.source_key,s.scope_id)=(r.partition_no,r.source_key,r.scope_id) FOR UPDATE;
  IF EXISTS(SELECT 1 FROM semantic.identity_scope_consumer_fence f
   WHERE (f.partition_no,f.source_key,f.scope_id)=(r.partition_no,r.source_key,r.scope_id)) THEN
   RAISE EXCEPTION 'identity_scope_consumer_fenced' USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;


--
-- Name: guard_identity_terminal_closure_key(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_identity_terminal_closure_key(r integer, id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE m semantic.identity_epoch_mapping;
BEGIN
 SELECT * INTO m FROM semantic.identity_epoch_mapping WHERE route=r AND original=id FOR UPDATE;
 IF NOT FOUND OR m.closure_state='legacy' THEN RETURN; END IF;
 IF m.closure_successor_ticket IS NOT NULL OR
    m.closure_state IN ('exporting','installed','active') OR
    (m.closure_state='withdrawn' AND m.closure_mutation_xid IS DISTINCT FROM pg_current_xact_id()::text)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
END; $$;


--
-- Name: guard_public_output_fresh_write(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_public_output_fresh_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE a record; p semantic.identity_public_output_progress;
BEGIN
 SELECT partition_no,capture_id,scope_key,hold_id INTO STRICT a FROM semantic.identity_public_output_accepted
 WHERE (partition_no,capture_id)=(NEW.partition_no,NEW.capture_id);
 IF EXISTS(SELECT 1 FROM semantic.identity_public_output_fence f
 WHERE (f.partition_no,f.capture_id)=(NEW.partition_no,NEW.capture_id)) OR NOT EXISTS(
 SELECT 1 FROM semantic.identity_scope_summary s WHERE s.partition_no=a.partition_no AND s.source_key=a.scope_key
 AND s.scope_id=a.capture_id::text AND s.registration=a.hold_id AND s.capture_id=a.capture_id
 AND s.revision=1 AND s.active=0 AND s.state IN ('capturing','ready'))
 THEN RAISE EXCEPTION 'public_output_capture_not_fresh' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT p FROM semantic.identity_public_output_progress
 WHERE (partition_no,capture_id)=(NEW.partition_no,NEW.capture_id);
 IF TG_TABLE_NAME='identity_public_output_seal' THEN
  IF NOT p.exhausted OR p.pending IS NOT NULL OR
  (NEW.version,NEW.manifest_digest,NEW.raw_count,NEW.canonical_count)
  IS DISTINCT FROM (p.version,p.manifest_digest,p.raw_count,p.canonical_count)
  THEN RAISE EXCEPTION 'public_output_seal_not_exhausted_manifest' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='identity_public_output_page' THEN
  IF p.exhausted OR p.pending IS NULL OR NEW.version<>p.version+1 OR NEW.predecessor<>p.manifest_digest
  OR (NEW.body-'receipts')<>p.pending OR jsonb_array_length(NEW.body->'rows')>8
  OR jsonb_array_length(NEW.body->'cuts')>16
  OR jsonb_array_length(NEW.body->'cuts')<>jsonb_array_length(NEW.body->'receipts')
  THEN RAISE EXCEPTION 'public_output_page_not_exact_plan' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_public_output_gate(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_public_output_gate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.partition_no,NEW.capture_id,NEW.original_epoch) IS DISTINCT FROM
   (OLD.partition_no,OLD.capture_id,OLD.original_epoch) OR OLD.state<>'open'
   OR (NEW.state='open' AND NEW.enrolled_count<>OLD.enrolled_count+1)
   OR (NEW.state<>'open' AND NEW.enrolled_count<>OLD.enrolled_count)
 THEN RAISE EXCEPTION 'public_output_enrollment_cannot_reopen'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_public_output_progress(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_public_output_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.partition_no,NEW.capture_id) IS DISTINCT FROM (OLD.partition_no,OLD.capture_id)
 OR NEW.version<OLD.version OR NEW.version>OLD.version+1 OR NEW.raw_count<OLD.raw_count
 OR NEW.canonical_count<OLD.canonical_count OR (OLD.exhausted AND NOT NEW.exhausted)
 OR NEW.closure_after<OLD.closure_after OR NEW.closure_after>NEW.version+(CASE WHEN NEW.pending IS NULL THEN 0 ELSE 1 END)
 OR (NEW.closure_after>OLD.closure_after AND NEW.closure_after<>OLD.closure_after+1)
 THEN RAISE EXCEPTION 'public_output_progress_cannot_reset' USING ERRCODE='23514'; END IF;
 IF (NEW.version,NEW.after_key,NEW.exhausted,NEW.manifest_digest,NEW.raw_count,NEW.canonical_count,NEW.pending)
 IS DISTINCT FROM (OLD.version,OLD.after_key,OLD.exhausted,OLD.manifest_digest,OLD.raw_count,OLD.canonical_count,OLD.pending)
 AND EXISTS(SELECT 1 FROM semantic.identity_public_output_fence f
 WHERE (f.partition_no,f.capture_id)=(NEW.partition_no,NEW.capture_id))
 THEN RAISE EXCEPTION 'public_output_capture_fenced' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_public_output_slot(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_public_output_slot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.partition_no,NEW.capture_partition,NEW.capture_id,NEW.original,NEW.generation,NEW.terminal)
 IS DISTINCT FROM (OLD.partition_no,OLD.capture_partition,OLD.capture_id,OLD.original,OLD.generation,OLD.terminal)
 OR (OLD.released AND NOT NEW.released)
 THEN RAISE EXCEPTION 'public_output_subject_send_cannot_reopen' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_record_source_set(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_record_source_set() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner semantic.record_source_set;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable Semantic record source set'; END IF;
 IF TG_TABLE_NAME='record_source_set' THEN
  IF TG_OP='UPDATE' AND (OLD.sealed OR OLD.native_xid<>pg_current_xact_id()::text
    OR (NEW.partition_no,NEW.transaction_id,NEW.revision,NEW.native_xid,NEW.erasure_key)
      IS DISTINCT FROM (OLD.partition_no,OLD.transaction_id,OLD.revision,OLD.native_xid,OLD.erasure_key)) THEN
   RAISE EXCEPTION 'Immutable Semantic record source set';
  END IF;
 ELSE
  SELECT * INTO STRICT owner FROM semantic.record_source_set
    WHERE partition_no=NEW.partition_no AND transaction_id=NEW.transaction_id;
  IF TG_OP<>'INSERT' OR owner.sealed OR owner.native_xid<>pg_current_xact_id()::text THEN
   RAISE EXCEPTION 'Immutable Semantic record source set membership';
  END IF;
  NEW.source_hash:=sha256(convert_to(NEW.source_key,'UTF8'));
  NEW.unit_hash:=sha256(convert_to(NEW.unit_key,'UTF8'));
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_subject_security(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_subject_security() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.security_revision < OLD.security_revision
     OR (NEW.visibility IS DISTINCT FROM OLD.visibility AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Visibility changes require an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: identity_epoch_bootstrap_remaining(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.identity_epoch_bootstrap_remaining() RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE WHEN (i.mode IS NOT NULL AND NOT i.valid)
      OR (i.mode IS NULL AND EXISTS (
        SELECT 1 FROM semantic.identity_epoch_installation_cut WHERE partition_no=0)) THEN 4096
    WHEN i.mode='absence' AND i.valid THEN 0 ELSE t.remaining END
  FROM semantic.identity_epoch_bootstrap_topology t
  LEFT JOIN semantic.read_identity_epoch_installation() i ON true WHERE t.partition_no=0;
$$;


--
-- Name: identity_epoch_installation_guards(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.identity_epoch_installation_guards() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT count(*)=5 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O' AND (
    (t.tgrelid='semantic.subject'::regclass AND t.tgname='identity_epoch_birth_custody'
      AND t.tgfoid='semantic.guard_identity_epoch_birth()'::regprocedure AND t.tgdeferrable AND t.tginitdeferred)
    OR (t.tgfoid='semantic.capture_identity_epoch_source()'::regprocedure AND (
      (t.tgrelid='semantic.subject'::regclass AND t.tgname='identity_epoch_capture_subject') OR
      (t.tgrelid='semantic.account_agent_subject'::regclass AND t.tgname='identity_epoch_capture_backlink') OR
      (t.tgrelid='semantic.redirect'::regclass AND t.tgname='identity_epoch_capture_redirect') OR
      (t.tgrelid='semantic.merge_member'::regclass AND t.tgname='identity_epoch_capture_member')))
  );
$$;


--
-- Name: identity_epoch_mapping_owns(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.identity_epoch_mapping_owns(r integer, id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping_fence f
 JOIN semantic.identity_epoch_mapping_effect e ON e.partition_no=r/16
   AND e.job_id=f.job_id AND e.job_epoch=f.job_epoch AND e.transaction_id=f.transaction_id
 WHERE f.route=r AND f.destination=id AND e.xmin::text=pg_current_xact_id()::text);
$$;


--
-- Name: identity_source_consumer_terminal_hook_installed(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.identity_source_consumer_terminal_hook_installed() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
  AND tgrelid=to_regclass('semantic.identity_epoch_source_consumer_terminal')
  AND tgname='identity_source_consumer_binding_fence'
  AND tgfoid='semantic.bind_identity_source_consumer_terminal()'::regprocedure);
$$;


--
-- Name: identity_source_consumer_terminal_matches(integer, bigint, bigint, jsonb, jsonb, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.identity_source_consumer_terminal_matches(p_home integer, p_custody bigint, p_sequence bigint, p_reference jsonb, p_generation jsonb, p_tx uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $_$
DECLARE matched boolean;
BEGIN
 IF NOT semantic.identity_source_consumer_terminal_hook_installed() THEN RETURN false; END IF;
 EXECUTE $q$SELECT EXISTS(
  SELECT 1 FROM semantic.identity_epoch_source_consumer_terminal t
  JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=t.partition_no
   AND r.erasure_key=t.custody_key
  JOIN semantic.erasure_source_commit n ON n.partition_no=t.partition_no
   AND n.transaction_id=t.transaction_id AND n.epoch=t.owner_epoch AND n.xmin=t.xmin
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
   AND p.write_state='active' AND p.moved_to IS NULL
   AND (p.position>=n.position OR (n.transaction_id=$6 AND n.position=p.position+1))
  WHERE t.partition_no=$1 AND t.custody_key=$2 AND t.sequence=$3 AND t.state=CASE WHEN $4->>'erasedRole'='subject' THEN 'discharged' ELSE 'transferred' END
   AND r.receipt_key::jsonb=jsonb_build_array($4#>>'{receipt,kind}',$4#>>'{receipt,account}',$4#>>'{receipt,receipt}')
   AND r.source_digest=$4->>'sourceDigest' AND r.source_epoch::text=$4#>>'{source,epoch}'
   AND r.source_position::text=$4#>>'{source,position}' AND r.source_transaction_id::text=$4#>>'{source,transactionId}'
   AND r.job_id::text=$4#>>'{job,jobId}' AND r.job_epoch::text=$4#>>'{job,epoch}'
   AND r.barrier_account_id::text=$4#>>'{barrier,accountId}'
   AND r.barrier_account_route::text=$4#>>'{barrier,accountRoute}'
   AND r.barrier_version::text=$4#>>'{barrier,version}' AND r.barrier_at=($4#>>'{barrier,at}')::timestamptz
   AND r.erased_role=$4->>'erasedRole' AND r.binding_generation=t.replay_generation
   AND t.replay_generation::text=$5->>'replayGeneration'
   AND t.undo_generation::text=$5->>'undoGeneration' AND t.restore_generation::text=$5->>'restoreGeneration'
 )$q$ INTO matched USING p_home,p_custody,p_sequence,p_reference,p_generation,p_tx;
 RETURN matched;
END $_$;


--
-- Name: immutable_kind_type_evidence_body(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.immutable_kind_type_evidence_body() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Kind Type dependency bodies are immutable';
END;
$$;


--
-- Name: invalidate_identity_prearm_release(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.invalidate_identity_prearm_release() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
  UPDATE semantic.identity_epoch_prearm_directory SET released=released
   WHERE partition_no=OLD.partition_no AND job_id=OLD.job_id AND generation=OLD.generation AND released;
 END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND
  (NEW.partition_no,NEW.job_id,NEW.generation) IS DISTINCT FROM (OLD.partition_no,OLD.job_id,OLD.generation)) THEN
  UPDATE semantic.identity_epoch_prearm_directory SET released=released
   WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id AND generation=NEW.generation AND released;
 END IF;
 RETURN NULL;
END; $$;


--
-- Name: keep_identity_epoch_accepted_binding(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.keep_identity_epoch_accepted_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE unchanged boolean; native_terminal boolean;
BEGIN
 unchanged := (to_jsonb(NEW)-ARRAY['consumer_undo_generation','consumer_undo_transaction_id',
  'consumer_terminal_custody','consumer_terminal_sequence']) =
  (to_jsonb(OLD)-ARRAY['consumer_undo_generation','consumer_undo_transaction_id',
  'consumer_terminal_custody','consumer_terminal_sequence']);
 IF OLD.state='accepted' AND NEW IS DISTINCT FROM OLD THEN
  IF NOT unchanged THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  IF (NEW.consumer_undo_generation,NEW.consumer_undo_transaction_id) IS DISTINCT FROM
     (OLD.consumer_undo_generation,OLD.consumer_undo_transaction_id) THEN
   IF OLD.consumer_terminal_custody IS NOT NULL OR OLD.consumer_undo_generation IS NULL
    OR NEW.consumer_undo_generation IS DISTINCT FROM OLD.consumer_undo_generation+1
    OR NEW.consumer_undo_transaction_id IS NOT DISTINCT FROM OLD.consumer_undo_transaction_id
    OR (NEW.consumer_terminal_custody,NEW.consumer_terminal_sequence) IS DISTINCT FROM
       (OLD.consumer_terminal_custody,OLD.consumer_terminal_sequence)
    OR NOT EXISTS(
      SELECT 1 FROM semantic.identity_epoch_receipt_claim c
      JOIN semantic.identity_epoch_native_commit n ON n.partition_no=c.partition_no
       AND n.transaction_id=c.transaction_id AND n.purpose='admission' AND n.xmin=c.xmin
      JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
       AND p.write_state='active' AND p.moved_to IS NULL AND n.position=p.position+1
      WHERE c.partition_no=OLD.partition_no AND c.transaction_id=NEW.consumer_undo_transaction_id AND NOT c.imported
       AND c.xmin=pg_current_xact_id()::xid AND c.receipt->>'kind'='account-agent.unverify'
       AND c.receipt->>'account'=OLD.account_id::text AND c.intent->>'kind'='unmerge'
       AND c.intent->'undoJob'->>'jobId'=OLD.accepted_job::text
       AND c.intent->'undoJob'->>'epoch'=OLD.accepted_epoch::text
       AND OLD.receipt_key::jsonb=jsonb_build_array('account-agent.verify',OLD.account_id::text,
         c.intent->>'verificationReceipt')
    ) THEN RAISE EXCEPTION 'identity_consumer_undo_not_native'; END IF;
  ELSE
   IF OLD.consumer_terminal_custody IS NOT NULL OR NEW.consumer_terminal_custody IS NULL
    OR to_regclass('semantic.identity_epoch_source_consumer_terminal') IS NULL THEN
    RAISE EXCEPTION 'identity_consumer_terminal_not_native';
   END IF;
   EXECUTE $q$SELECT EXISTS(
    SELECT 1 FROM semantic.identity_epoch_source_consumer_terminal t
    JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=t.partition_no
     AND r.erasure_key=t.custody_key
    JOIN semantic.erasure_source_commit n ON n.partition_no=t.partition_no
     AND n.transaction_id=t.transaction_id AND n.epoch=t.owner_epoch AND n.xmin=t.xmin
    JOIN semantic.identity_epoch_receipt_claim_commit k ON k.partition_no=r.partition_no
     AND k.receipt_key=r.receipt_key AND k.generation=r.binding_generation
     AND k.transaction_id=r.binding_transaction_id
    JOIN semantic.identity_epoch_native_commit original ON original.partition_no=k.partition_no
     AND original.transaction_id=k.transaction_id AND original.purpose='admission' AND original.xmin=k.xmin
    JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
     AND p.write_state='active' AND p.moved_to IS NULL AND n.position=p.position+1
    WHERE t.partition_no=$1 AND t.custody_key=$2 AND t.sequence=$3
     AND t.state IN ('transferred','discharged') AND t.xmin=pg_current_xact_id()::xid
     AND r.receipt_key=$4 AND r.binding_generation=$5 AND r.source_digest=$6
     AND r.job_id=$7 AND r.job_epoch=$8 AND t.replay_generation=$5
     AND t.undo_generation=$9 AND t.restore_generation=original.epoch
   )$q$ INTO native_terminal USING OLD.partition_no,NEW.consumer_terminal_custody,
    NEW.consumer_terminal_sequence,OLD.receipt_key,OLD.generation,OLD.intent_digest,
    OLD.accepted_job,OLD.accepted_epoch,OLD.consumer_undo_generation;
   IF NOT native_terminal THEN RAISE EXCEPTION 'identity_consumer_terminal_not_native'; END IF;
  END IF;
 END IF;
 IF (OLD.partition_no,OLD.receipt_key,OLD.account_id,OLD.intent_digest) IS DISTINCT FROM
    (NEW.partition_no,NEW.receipt_key,NEW.account_id,NEW.intent_digest) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 RETURN NEW;
END $_$;


--
-- Name: lock_identity_source_history_handoff(jsonb, jsonb); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.lock_identity_source_history_handoff(p_reference jsonb, p_expected jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE authority jsonb;
BEGIN
 -- The receiving owner is home zero. There is no cross-home atomic bridge here.
 IF p_reference IS NULL OR octet_length(p_reference::text)>2048
  OR octet_length(p_expected::text)>4096
  OR p_reference#>>'{source,partition}' IS DISTINCT FROM '0'
  OR (p_reference#>>'{barrier,accountRoute}')::integer/16 IS DISTINCT FROM 0 THEN RETURN NULL; END IF;

 SELECT jsonb_build_object(
   'kind','identity-source-history-guard/v1',
   'custody',r.erasure_key::text,'sequence',t.sequence::text,
   -- Reconstruct the closed address from ORIGINAL native fields. Extra caller
   -- JSON must never become persisted payload in a later History consumer.
   'reference',jsonb_build_object(
     'receipt',c.receipt,'sourceDigest',r.source_digest,'erasedRole',r.erased_role,
     'source',jsonb_build_object('partition',r.partition_no,'epoch',r.source_epoch,
       'position',r.source_position::text,'transactionId',r.source_transaction_id),
     'job',jsonb_build_object('jobId',r.job_id,'epoch',r.job_epoch::text),
     'barrier',jsonb_build_object('accountId',r.barrier_account_id,
       'accountRoute',r.barrier_account_route,'version',r.barrier_version,'at',r.barrier_at::text)),
   'generation',jsonb_build_object('replayGeneration',t.replay_generation::text,
     'undoGeneration',t.undo_generation::text,'restoreGeneration',t.restore_generation::text),
   'disposition',t.state,
   'terminal',jsonb_build_object('partition',t.partition_no,'epoch',t.owner_epoch,
     'position',terminal_commit.position::text,'transactionId',t.transaction_id),
   'receiving',CASE WHEN t.state='transferred' THEN jsonb_build_object(
     'partition',t.receiving_partition,'epoch',t.receiving_epoch,
     'position',t.receiving_position::text,'transactionId',t.receiving_transaction_id) ELSE NULL END
 ) INTO authority
 FROM semantic.identity_epoch_receipt_binding b
 JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=b.partition_no
  AND r.erasure_key=b.consumer_terminal_custody AND r.receipt_key=b.receipt_key
  AND r.binding_generation=b.generation AND r.source_digest=b.intent_digest
  AND r.job_id=b.accepted_job AND r.job_epoch=b.accepted_epoch
 JOIN semantic.identity_epoch_source_consumer_terminal t ON t.partition_no=r.partition_no
  AND t.custody_key=r.erasure_key AND t.sequence=b.consumer_terminal_sequence
  AND t.replay_generation=b.generation AND t.undo_generation=b.consumer_undo_generation
 JOIN semantic.identity_epoch_receipt_claim c ON c.partition_no=b.partition_no
  AND c.receipt_key=b.receipt_key AND c.generation=b.generation
  AND c.intent_digest=b.intent_digest AND c.scope_digest=r.scope_digest
  AND c.job_id=r.job_id AND c.job_epoch=r.job_epoch AND NOT c.imported
 JOIN semantic.identity_epoch_receipt_claim_commit k ON k.partition_no=c.partition_no
  AND k.receipt_key=c.receipt_key AND k.generation=c.generation
  AND k.transaction_id=r.binding_transaction_id AND k.transaction_id=c.transaction_id AND k.xmin=c.xmin
 JOIN semantic.identity_epoch_native_commit admission ON admission.partition_no=k.partition_no
  AND admission.transaction_id=k.transaction_id AND admission.purpose='admission' AND admission.xmin=k.xmin
 JOIN semantic.identity_epoch_native_commit undo ON undo.partition_no=b.partition_no
  AND undo.transaction_id=b.consumer_undo_transaction_id AND undo.purpose='admission'
 JOIN semantic.erasure_source_commit retained ON retained.partition_no=r.partition_no
  AND retained.transaction_id=r.transaction_id AND retained.epoch=r.owner_epoch AND retained.xmin=r.xmin
 JOIN semantic.erasure_source_commit terminal_commit ON terminal_commit.partition_no=t.partition_no
  AND terminal_commit.transaction_id=t.transaction_id AND terminal_commit.epoch=t.owner_epoch
  AND terminal_commit.xmin=t.xmin
 JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active' AND p.moved_to IS NULL
  AND p.epoch=r.source_epoch AND p.epoch=r.owner_epoch AND p.epoch=t.owner_epoch
  AND p.epoch=admission.epoch AND p.epoch=undo.epoch AND p.epoch=t.restore_generation
  AND p.position>=r.source_position AND p.position>=admission.position AND p.position>=undo.position
  AND p.position>=retained.position AND p.position>=terminal_commit.position
 JOIN semantic.erasure_source_role retained_role ON retained_role.partition_no=r.partition_no
  AND retained_role.transaction_id=r.transaction_id AND retained_role.account_id=r.barrier_account_id
  AND retained_role.role=CASE r.erased_role WHEN 'subject' THEN 'subject' WHEN 'requester' THEN 'actor' ELSE 'editor' END
 JOIN semantic.erasure_source_role terminal_role ON terminal_role.partition_no=t.partition_no
  AND terminal_role.transaction_id=t.transaction_id AND terminal_role.account_id=r.barrier_account_id
  AND terminal_role.role=retained_role.role
 JOIN semantic.erasure_locator retained_locator ON retained_locator.partition_no=r.partition_no
  AND retained_locator.account_id=r.barrier_account_id AND retained_locator.role=retained_role.role
  AND retained_locator.store='identity_epoch_source_consumer_custody' AND retained_locator.record_key=r.erasure_key
  AND retained_locator.source_transaction_id=r.transaction_id
 JOIN semantic.erasure_locator terminal_locator ON terminal_locator.partition_no=t.partition_no
  AND terminal_locator.account_id=r.barrier_account_id AND terminal_locator.role=terminal_role.role
  AND terminal_locator.store='identity_epoch_source_consumer_terminal' AND terminal_locator.record_key=t.erasure_key
  AND terminal_locator.source_transaction_id=t.transaction_id
 JOIN pg_catalog.pg_trigger hook ON hook.tgrelid='semantic.identity_epoch_source_consumer_terminal'::regclass
  AND hook.tgname='identity_source_consumer_binding_fence' AND NOT hook.tgisinternal AND hook.tgenabled='O'
  AND hook.tgfoid='semantic.bind_identity_source_consumer_terminal()'::regprocedure
 WHERE b.partition_no=0 AND b.state='accepted'
  AND b.receipt_key=format('[%s,%s,%s]',to_json(p_reference#>>'{receipt,kind}'),
    to_json(p_reference#>>'{receipt,account}'),to_json(p_reference#>>'{receipt,receipt}'))
  AND c.receipt=p_reference->'receipt' AND b.account_id::text=p_reference#>>'{receipt,account}'
  AND r.source_digest=p_reference->>'sourceDigest'
  AND r.source_epoch::text=p_reference#>>'{source,epoch}'
  AND r.source_position::text=p_reference#>>'{source,position}'
  AND r.source_transaction_id::text=p_reference#>>'{source,transactionId}'
  AND r.job_id::text=p_reference#>>'{job,jobId}' AND r.job_epoch::text=p_reference#>>'{job,epoch}'
  AND r.barrier_account_id::text=p_reference#>>'{barrier,accountId}'
  AND r.barrier_account_route::text=p_reference#>>'{barrier,accountRoute}'
  AND r.barrier_version::text=p_reference#>>'{barrier,version}'
  AND r.barrier_at=(p_reference#>>'{barrier,at}')::timestamptz
  AND r.erased_role=p_reference->>'erasedRole'
  AND ((r.erased_role='subject' AND t.state='discharged' AND r.barrier_account_id=b.account_id)
    OR (r.erased_role IN ('requester','decider') AND t.state='transferred'
      AND t.receiving_partition=0 AND t.receiving_epoch=p.epoch
      AND t.receiving_position>0 AND t.receiving_transaction_id IS NOT NULL))
 FOR UPDATE OF b FOR SHARE OF r,t,c,k,admission,undo,retained,terminal_commit,p,
   retained_role,terminal_role,retained_locator,terminal_locator;

 IF p_expected IS NOT NULL AND authority IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
 RETURN authority;
END $$;


--
-- Name: prepare_identity_epoch_admission(integer, uuid, bigint, text); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prepare_identity_epoch_admission(p_home integer, p_job uuid, p_epoch bigint, p_scope text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE a semantic.identity_epoch_admission_attempt;c semantic.identity_epoch_control;h semantic.identity_epoch_admission_handoff;i record;b semantic.identity_epoch_prearm_bridge;
BEGIN
 SELECT * INTO c FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 SELECT * INTO a FROM semantic.identity_epoch_admission_attempt WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
 IF FOUND THEN
  IF a.state='closed' OR a.job_epoch<>p_epoch OR a.scope_digest<>p_scope THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  RETURN;
 END IF;
 SELECT * INTO h FROM semantic.identity_epoch_admission_handoff WHERE partition_no=p_home AND job_id=p_job;
 IF NOT FOUND OR h.job_epoch<>p_epoch OR h.scope_digest<>p_scope THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF (c.pending_job IS NOT NULL AND c.pending_job<>p_job) OR (c.prepare_job IS NOT NULL AND c.prepare_job<>p_job)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 FOR i IN SELECT * FROM jsonb_to_recordset(h.inputs) r(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer) ORDER BY terminal LOOP
  PERFORM 1 FROM semantic.identity_epoch_group g JOIN core.partition p ON p.partition_no=g.partition_no
   AND p.epoch=g.owner_epoch AND p.write_state='active' WHERE g.partition_no=p_home AND g.terminal=i.terminal
   AND g.generation=i.generation AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch AND g.pending_job IS NULL FOR UPDATE OF g;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  INSERT INTO semantic.identity_epoch_prearm_bridge(partition_no,generation,terminal,owner_epoch,basis_version)
   VALUES(p_home,i.generation,i.terminal,i.owner_epoch,i.basis_version) ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM semantic.identity_epoch_prearm_bridge WHERE partition_no=p_home AND generation=i.generation FOR UPDATE;
  IF b.terminal<>i.terminal OR b.owner_epoch<>i.owner_epoch OR b.basis_version<>i.basis_version OR
   (b.job_id IS NOT NULL AND (b.job_id<>p_job OR b.job_epoch<>p_epoch OR b.scope_digest<>p_scope))
  THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  UPDATE semantic.identity_epoch_prearm_bridge SET job_id=p_job,job_epoch=p_epoch,scope_digest=p_scope,bridge_version=bridge_version+1
   WHERE partition_no=p_home AND generation=i.generation;
 END LOOP;
 INSERT INTO semantic.identity_epoch_admission_attempt(partition_no,job_id,job_epoch,scope_digest,state)
  VALUES(p_home,p_job,p_epoch,p_scope,'prepared');
 UPDATE semantic.identity_epoch_control SET prepare_job=p_job,prepare_epoch=p_epoch,allocated_epoch=greatest(allocated_epoch,p_epoch) WHERE partition_no=p_home;
END; $$;


--
-- Name: prepare_identity_epoch_installation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prepare_identity_epoch_installation() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE installed record; legacy boolean;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'identity_epoch_installation_requires_read_committed';
  END IF;
  SELECT * INTO installed FROM semantic.identity_epoch_installation_cut WHERE partition_no=0;
  IF FOUND THEN
    IF NOT semantic.identity_epoch_installation_guards() THEN RAISE EXCEPTION 'identity_epoch_installation_unavailable'; END IF;
    RETURN installed.mode;
  END IF;
  -- Drain old writers and exclude concurrent native/legacy installation or source mutations.
  -- Enabling the deferred birth guard and committing the native proof occur under these locks.
  LOCK TABLE semantic.subject,semantic.revision,semantic.redirect,semantic.merge_member,
    semantic.account_agent_subject,semantic.identity_epoch_mapping,semantic.identity_epoch_home_gate,
    semantic.identity_epoch_dirty,semantic.identity_epoch_member_dirty,semantic.identity_epoch_bootstrap_home,
    semantic.identity_epoch_bootstrap_page IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO installed FROM semantic.identity_epoch_installation_cut WHERE partition_no=0;
  IF FOUND THEN
    IF NOT semantic.identity_epoch_installation_guards() THEN RAISE EXCEPTION 'identity_epoch_installation_unavailable'; END IF;
    RETURN installed.mode;
  END IF;
  -- These are complete structural source relations, not a projection/checkpoint or selected homes.
  -- A revision-1 native birth is excluded only with its actual same-transaction self custody.
  SELECT EXISTS (
    SELECT 1 FROM semantic.subject s WHERE NOT EXISTS (
      SELECT 1 FROM semantic.revision r
      JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(r.route,r.subject_id)
      JOIN semantic.identity_epoch_home_gate g ON (g.route,g.destination,g.original)=(r.route,r.subject_id,r.subject_id)
      JOIN core.partition p ON p.partition_no=r.route/16
      WHERE r.route=s.route AND r.subject_id=s.subject_id AND r.revision=1 AND r.kind='create'
        AND r.recorded_transaction_id=m.recorded_transaction_id AND r.recorded_transaction_id=g.recorded_transaction_id
        AND r.xmin=m.xmin AND r.xmin=g.xmin AND m.origin='creation'
        AND m.terminal=r.subject_id AND m.control_group=r.subject_id AND m.control_partition=r.route/16
        AND m.owner_epoch=p.epoch AND p.write_state='active'
        AND m.epoch>0 AND g.epoch=m.epoch AND g.terminal=r.subject_id AND g.pending_job IS NULL AND g.pending_epoch IS NULL
    )
  ) OR EXISTS (SELECT 1 FROM semantic.revision r WHERE NOT EXISTS (
    SELECT 1 FROM semantic.subject s WHERE (s.route,s.subject_id)=(r.route,r.subject_id)))
    OR EXISTS (SELECT 1 FROM semantic.redirect)
    OR EXISTS (SELECT 1 FROM semantic.merge_member)
    OR EXISTS (SELECT 1 FROM semantic.account_agent_subject a WHERE NOT EXISTS (
      SELECT 1 FROM semantic.subject s WHERE (s.route,s.subject_id)=(a.route,a.subject_id)))
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_dirty WHERE revision<>captured_revision)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_member_dirty)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_home)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_page)
    INTO legacy;
  ALTER TABLE semantic.subject ENABLE TRIGGER identity_epoch_birth_custody;
  IF NOT semantic.identity_epoch_installation_guards() THEN RAISE EXCEPTION 'identity_epoch_installation_unavailable'; END IF;
  INSERT INTO semantic.identity_epoch_installation_cut VALUES
    (0,CASE WHEN legacy THEN 'legacy' ELSE 'absence' END,pg_current_xact_id()::text);
  RETURN CASE WHEN legacy THEN 'legacy' ELSE 'absence' END;
END; $$;


--
-- Name: prevent_fact_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: prevent_moderation_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_moderation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND (semantic.erasure_mutation_allowed(TG_TABLE_NAME,OLD.route,OLD.erasure_key)
  OR semantic.record_retention_mutation_allowed(TG_TABLE_NAME,OLD.route,OLD.erasure_key))
  AND NEW.body='{}'::jsonb AND NEW.actor IS NULL
  AND (to_jsonb(NEW)-ARRAY['body','actor'])=(to_jsonb(OLD)-ARRAY['body','actor']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Semantic moderation records are immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: prevent_redirect_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_redirect_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1
      FROM semantic.revision AS revision
      WHERE revision.route = OLD.route AND revision.subject_id = OLD.subject_id
        AND revision.revision = (
          SELECT max(latest.revision)
          FROM semantic.revision AS latest
          WHERE latest.route = OLD.route AND latest.subject_id = OLD.subject_id
        )
        AND revision.revocation_receipt_id IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Semantic redirects are immutable' USING ERRCODE = '23514';
  END;
  $$;


--
-- Name: prevent_revision_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_revision_mutation() RETURNS trigger
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


--
-- Name: protect_identity_epoch_job(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: protect_record_retention_commit(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.protect_record_retention_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'record_retention_commit_is_immutable'; END; $$;


--
-- Name: public_filter_native_json(jsonb); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.public_filter_native_json(value jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
DECLARE result jsonb; entry jsonb;
BEGIN
  CASE value->>0
    WHEN 'scalar','value','bigint' THEN RETURN value->1;
    WHEN 'undefined' THEN RETURN 'null'::jsonb;
    WHEN 'array' THEN
      result := '[]'::jsonb;
      FOR entry IN SELECT jsonb_array_elements(value->1) LOOP
        result := result || jsonb_build_array(semantic.public_filter_native_json(entry));
      END LOOP;
      RETURN result;
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR entry IN SELECT jsonb_array_elements(value->1) LOOP
        result := result || jsonb_build_object(entry->>0,semantic.public_filter_native_json(entry->1));
      END LOOP;
      RETURN result;
    ELSE RAISE EXCEPTION 'Invalid native public-filter encoding';
  END CASE;
END $$;


--
-- Name: read_identity_epoch_installation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.read_identity_epoch_installation() RETURNS TABLE(mode text, transaction_id uuid, epoch integer, "position" bigint, installation_xid text, valid boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT i.mode,i.transaction_id,c.epoch,c.position,k.installation_xid,
    coalesce(c.purpose='bootstrap' AND p.write_state='active' AND p.epoch=c.epoch AND p.position>=c.position
      AND i.mode=k.mode AND semantic.identity_epoch_installation_guards(),false)
  FROM semantic.identity_epoch_installation i
  JOIN semantic.identity_epoch_installation_cut k USING(partition_no)
  LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(i.partition_no,i.transaction_id)
  LEFT JOIN core.partition p ON p.partition_no=i.partition_no WHERE i.partition_no=0;
$$;


--
-- Name: receive_identity_epoch_empty_bootstrap(integer, uuid, integer, bigint, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.receive_identity_epoch_empty_bootstrap(p_home integer, p_export uuid, p_epoch integer, p_position bigint, p_tx uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE owner record;
BEGIN
  PERFORM 1 FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM semantic.identity_epoch_bootstrap_page page
    JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(page.partition_no,page.transaction_id)
    JOIN core.partition p ON p.partition_no=page.partition_no
    WHERE page.partition_no=p_home AND page.transaction_id=p_export AND page.generation=1
      AND page.phase='member-dirty' AND page.caught_up AND NOT page.acknowledged AND page.xmin=c.xmin
      AND c.purpose='bootstrap' AND c.epoch=p_epoch AND c.position=p_position
      AND p.write_state='active' AND p.epoch=c.epoch AND p.position>=c.position
  ) OR EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_row
      WHERE partition_no=p_home AND transaction_id=p_export)
    THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  -- Recovery of any already-delivered stage uses the existing retained-page protocol.
  IF EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_basis
      WHERE partition_no=p_home AND source_partition=p_home AND source_generation=1)
    THEN RETURN false; END IF;
  SELECT * INTO owner FROM core.partition WHERE partition_no=p_home AND write_state='active' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  INSERT INTO semantic.identity_epoch_bootstrap_custody
    (partition_no,source_partition,source_generation,native_transaction_id,native_epoch,native_position,stage)
    VALUES(p_home,p_home,1,p_export,p_epoch,p_position,'add') ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_custody
      WHERE partition_no=p_home AND source_partition=p_home AND source_generation=1 AND stage='add'
        AND native_transaction_id=p_export AND native_epoch=p_epoch AND native_position=p_position)
    THEN RAISE EXCEPTION 'identity_epoch_bootstrap_custody_unavailable'; END IF;
  INSERT INTO semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position,purpose)
    VALUES(p_home,p_tx,owner.epoch,owner.position+1,'bootstrap');
  INSERT INTO semantic.identity_epoch_bootstrap_basis
    (partition_no,source_partition,source_generation,source_transaction_id,transaction_id,native_epoch,native_position)
    VALUES(p_home,p_home,1,p_export,p_tx,owner.epoch,owner.position+1);
  RETURN true;
END; $$;


--
-- Name: record_erasure_locator(integer, uuid, text, text, bigint, uuid, bigint); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_erasure_locator(p_home integer, p_account uuid, p_role text, p_store text, p_key bigint, p_tx uuid, p_position bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE delivery bigint; is_global boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM semantic.erasure_source_seal s WHERE s.partition_no=p_home AND s.account_id=p_account) THEN
  -- Re-reporting unchanged provenance of a survivor's existing row creates no new role.
  IF p_position IS NULL THEN
   IF EXISTS(SELECT 1 FROM semantic.erasure_source_record l WHERE l.partition_no=p_home AND l.account_id=p_account
     AND l.role=p_role AND l.store=p_store AND l.record_key=p_key
     AND coalesce(l.source_transaction_id::text,'')=coalesce(p_tx::text,'')) THEN RETURN; END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM semantic.erasure_source_record l WHERE l.partition_no=p_home AND l.account_id=p_account
     AND l.role=p_role AND l.store=p_store AND l.record_key=p_key
     AND coalesce(l.source_transaction_id::text,'')=coalesce(p_tx::text,'') AND l.source_position=p_position) THEN RETURN; END IF;
  END IF;
  RAISE EXCEPTION 'Semantic erased Source role admission is sealed' USING ERRCODE='23514';
 END IF;
 -- A command-body Source enrollment has a deferred native fence, never a setting as proof.
 SELECT coalesce((SELECT c.position FROM semantic.erasure_source_commit c
   WHERE c.partition_no=p_home AND c.epoch=p.epoch AND c.position=p.position+1
     AND c.xmin::text=pg_current_xact_id()::text),p.position)
 INTO delivery FROM core.partition p WHERE p.partition_no=p_home;
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


--
-- Name: record_purge_command_commit(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_purge_command_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 UPDATE semantic.record_purge_command c SET epoch=b.epoch,position=b.position FROM editorial.write_basis b
 WHERE c.partition_no=NEW.partition_no AND c.source_key=NEW.source_key AND c.key=NEW.key
 AND b.partition_no=c.partition_no AND b.transaction_id=c.transaction_id AND b.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN
  UPDATE semantic.record_purge_command c SET epoch=r.epoch,position=r.position FROM core.receipt r
  WHERE c.partition_no=NEW.partition_no AND c.source_key=NEW.source_key AND c.key=NEW.key
  AND r.partition_no=c.partition_no AND r.transaction_id=c.transaction_id AND r.xmin=pg_current_xact_id()::xid;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_source_requires_same_native_commit'; END IF;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_purge_hold_immutable(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_purge_hold_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'released') IS DISTINCT FROM (to_jsonb(OLD)-'released')
    OR (OLD.released AND NOT NEW.released) THEN RAISE EXCEPTION 'record_purge_hold_is_immutable'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_purge_receiving_completion(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_purge_receiving_completion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF OLD.completion_transaction_id IS NOT NULL OR NEW.completion_transaction_id IS NULL THEN RETURN NEW; END IF;
 UPDATE semantic.record_purge_receiving r SET completion_position=b.position FROM editorial.write_basis b
 WHERE r.partition_no=NEW.partition_no AND r.hold_id=NEW.hold_id
 AND b.partition_no=r.partition_no AND b.transaction_id=r.completion_transaction_id AND b.epoch=r.receiver_epoch
 AND b.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN RAISE EXCEPTION 'record_purge_completion_requires_same_native_command'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_purge_receiving_immutable(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_purge_receiving_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR
   (to_jsonb(NEW)-'completion_transaction_id'-'completion_position') IS DISTINCT FROM
   (to_jsonb(OLD)-'completion_transaction_id'-'completion_position') OR
   (OLD.completion_transaction_id IS NOT NULL AND NEW.completion_transaction_id IS DISTINCT FROM OLD.completion_transaction_id) OR
   (OLD.completion_position IS NOT NULL AND NEW.completion_position IS DISTINCT FROM OLD.completion_position)
 THEN RAISE EXCEPTION 'record_purge_receiving_is_immutable'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_purge_resource_writer(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_purge_resource_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_id uuid; v_kind text; v_transaction uuid;
BEGIN
 IF TG_TABLE_NAME='zone' THEN v_id:=NEW.zone_id;v_kind:='zone';v_transaction:=NEW.transaction_id;
 ELSE v_id:=NEW.context_id;v_kind:='context';
  v_transaction:=NEW.recorded_transaction_id;
  IF TG_TABLE_NAME='context' THEN
   IF TG_OP='UPDATE' AND NEW.state='deleted' AND OLD.state='active' THEN
    v_transaction:=NEW.deletion_transaction_id;
   END IF;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=NEW.route/16
   AND b.transaction_id=v_transaction AND b.xmin=pg_current_xact_id()::xid) AND NOT EXISTS (
   SELECT 1 FROM semantic.record_purge_command c JOIN semantic.record_purge_writer w USING(partition_no,source_key)
   WHERE w.route=NEW.route AND w.kind=v_kind AND w.resource_id=v_id AND c.transaction_id=v_transaction
 ) THEN
  UPDATE semantic.record_purge_writer SET enrolled=false,sealed_cut=NULL
   WHERE route=NEW.route AND kind=v_kind AND resource_id=v_id;
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_purge_source_gate(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_purge_source_gate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r integer; v_kind text; v_owner uuid; id uuid; item jsonb;
BEGIN
 item:=CASE WHEN TG_OP='INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
 r:=(item->>'route')::integer;
 IF TG_TABLE_NAME IN ('context','context_extension','context_extension_activation') THEN v_kind:='context';v_owner:=(item->>'context_id')::uuid;id:=v_owner;
 ELSIF TG_TABLE_NAME='zone' THEN v_kind:='zone';v_owner:=(item->>'zone_id')::uuid;id:=v_owner;
 ELSE v_kind:='contribution';v_owner:=(item->>'subject_id')::uuid;id:=(item->>'candidate_id')::uuid;
 END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME IN ('context_extension','context_extension_activation') THEN
  PERFORM 1 FROM semantic.context WHERE route=r AND context_id=v_owner FOR UPDATE;
  IF EXISTS(SELECT 1 FROM semantic.record_purge_writer WHERE route=r AND kind='context'
    AND resource_id=v_owner AND sealed_cut IS NOT NULL) THEN RAISE EXCEPTION 'record_purge_source_inventory_sealed'; END IF;
 ELSIF TG_TABLE_NAME='hidden_candidate' THEN
  PERFORM 1 FROM semantic.subject WHERE route=r AND subject_id=v_owner FOR UPDATE;
  PERFORM 1 FROM semantic.record_lifecycle WHERE route=r AND subject_id=v_owner AND candidate_id=id FOR UPDATE;
 END IF;
 IF EXISTS(SELECT 1 FROM semantic.record_purge_hold h WHERE h.route=r AND h.kind=v_kind
   AND h.owner_id=v_owner AND (id IS NULL OR h.record_id=id) AND NOT h.released LIMIT 1) THEN
  RAISE EXCEPTION 'record_purge_receiving_hold_outstanding' USING ERRCODE='55P03';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_purge_source_home_gate(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_purge_source_home_gate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF (NEW.epoch,NEW.write_state,NEW.moved_to) IS DISTINCT FROM (OLD.epoch,OLD.write_state,OLD.moved_to)
 AND EXISTS(SELECT 1 FROM semantic.record_purge_hold h WHERE h.partition_no=OLD.partition_no AND NOT h.released LIMIT 1)
 THEN RAISE EXCEPTION 'record_purge_source_home_hold_outstanding' USING ERRCODE='55P03'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: record_retention_mutation_allowed(text, integer, bigint); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.record_retention_mutation_allowed(p_store text, p_route integer, p_key bigint) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
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


--
-- Name: require_record_source_member(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.require_record_source_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner semantic.record_source_set; v_revision integer; v_candidate uuid; v_kind text; v_field text; v_language text;
BEGIN
 SELECT * INTO owner FROM semantic.record_source_set
 WHERE partition_no=NEW.route/16 AND native_xid=pg_current_xact_id()::text;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='candidate' THEN
  v_revision:=NEW.revision; v_candidate:=NEW.candidate_id; v_kind:='contribution';
 ELSE
  IF NEW.operation='expand' THEN RETURN NEW; END IF;
  SELECT r.revision INTO v_revision FROM semantic.revision r WHERE r.route=NEW.route
   AND r.subject_id=NEW.subject_id AND r.recorded_transaction_id=NEW.recorded_transaction_id;
  v_candidate:=NEW.statement_id; v_language:=NEW.language;
  v_kind:=CASE WHEN NEW.kind='statement' THEN 'contribution' ELSE 'terms' END;
  v_field:=CASE NEW.kind WHEN 'label' THEN 'labels' WHEN 'description' THEN 'descriptions' WHEN 'alias' THEN 'aliases' END;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM semantic.record_source_set_member m WHERE m.partition_no=owner.partition_no
  AND m.transaction_id=owner.transaction_id AND m.kind=v_kind AND m.subject_id=NEW.subject_id
  AND m.source_revision=v_revision AND m.candidate_id IS NOT DISTINCT FROM v_candidate
  AND ((v_kind='contribution' AND m.document_id IS NULL) OR (v_kind='terms' AND m.field=v_field AND m.language=v_language))) THEN
  RAISE EXCEPTION 'Semantic record source set omitted an actual native source unit' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: resource_record_purge_commit(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.resource_record_purge_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE id uuid; generation uuid; v_transaction uuid; version bigint; due timestamptz;
BEGIN
 IF NOT (NEW.state='deleted' AND OLD.state='active') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='context' THEN
  id:=NEW.context_id;v_transaction:=NEW.deletion_transaction_id;version:=NEW.security_revision;due:=NEW.purge_after;
 ELSE
  id:=NEW.zone_id;v_transaction:=NEW.transaction_id;version:=NEW.revision;due:=NEW.restore_until;
 END IF;
 INSERT INTO semantic.resource_record_purge_commit
 (route,kind,resource_id,deletion_generation,transaction_id,epoch,position,source_version,deleted_at,purge_after)
 SELECT NEW.route,TG_TABLE_NAME,id,NEW.deletion_generation,v_transaction,b.epoch,b.position,version,NEW.deleted_at,due
 FROM editorial.write_basis b WHERE b.partition_no=NEW.route/16 AND b.transaction_id=v_transaction
 AND b.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource_deletion_requires_same_native_commit'; END IF;
 RETURN NEW;
END; $$;


--
-- Name: resource_record_purge_generation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.resource_record_purge_generation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.state='deleted' AND OLD.state='active' THEN NEW.deletion_generation:=gen_random_uuid(); END IF;
 RETURN NEW;
END; $$;


--
-- Name: retain_public_filter_baseline_seal(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_baseline_seal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.coverage_generation IS NOT NULL AND
    NEW.coverage_generation IS DISTINCT FROM OLD.coverage_generation THEN
    RAISE EXCEPTION 'Original covered generation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.coverage_sealed AND
    (NEW.coverage_after,NEW.coverage_root,NEW.coverage_sealed,NEW.account_after)
    IS DISTINCT FROM
    (OLD.coverage_after,OLD.coverage_root,OLD.coverage_sealed,OLD.account_after)
  THEN
    RAISE EXCEPTION 'Original public-filter baseline seal is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.coverage_after,NEW.coverage_root,NEW.coverage_sealed)
    IS DISTINCT FROM (OLD.coverage_after,OLD.coverage_root,OLD.coverage_sealed)
    AND NOT (OLD.coverage_generation IS NULL AND NEW.coverage_after=0 AND NOT NEW.coverage_sealed)
    AND (NEW.coverage_after<>OLD.coverage_after+1 OR NEW.account_after<>NEW.coverage_after OR NOT EXISTS (
      SELECT 1 FROM search.public_filter_coverage_preparation c
      WHERE c.partition_no=NEW.partition_no AND c.bootstrap=NEW.bootstrap
        AND c.definition=NEW.read_definition AND c.generation=NEW.coverage_generation
        AND c.after_home=NEW.coverage_after AND c.root=NEW.coverage_root))
  THEN
    RAISE EXCEPTION 'Source seal requires its native contiguous coverage preparation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_creation_checkpoint(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_creation_checkpoint() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE original semantic.public_filter_home_enrollment;
BEGIN
  IF OLD.consumer !~ '^public_filter_[0-9a-f]{32}$' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT * INTO original FROM semantic.public_filter_home_enrollment
    WHERE (partition_no,bootstrap)=
      (OLD.partition_no,substring(OLD.consumer FROM 15)::uuid)
      AND creation_consumer=OLD.consumer;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' OR
    (NEW.partition_no,NEW.consumer,NEW.epoch,NEW.position)
      IS DISTINCT FROM (OLD.partition_no,OLD.consumer,OLD.epoch,OLD.position) THEN
    RAISE EXCEPTION 'Original public-filter creation pin is still retained'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $_$;


--
-- Name: retain_public_filter_definition(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_definition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.partition_no,NEW.read_definition,NEW.source_id,NEW.configuration,NEW.release_digest,
      NEW.subject_type,NEW.capture_digest,NEW.capture,NEW.dependency_keys) IS DISTINCT FROM
     (OLD.partition_no,OLD.read_definition,OLD.source_id,OLD.configuration,OLD.release_digest,
      OLD.subject_type,OLD.capture_digest,OLD.capture,OLD.dependency_keys)
     OR (OLD.coverage_keys IS NOT NULL AND NEW.coverage_keys IS DISTINCT FROM OLD.coverage_keys) THEN
    RAISE EXCEPTION 'Original public-filter definitions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_enrollment_window(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_enrollment_window() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.captured_enrollment_generation IS NOT NULL
    AND coalesce(NEW.native_captured_enqueue,NEW.captured_revision) IS NOT NULL
    AND NEW.captured_enrollment_generation IS DISTINCT FROM OLD.captured_enrollment_generation THEN
    RAISE EXCEPTION 'Original Source enrollment window is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_home_receipt(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_home_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.receipt IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Original public-filter home receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.receipt IS NOT NULL AND
    (NOT NEW.complete OR NEW.creation_position IS NULL OR NEW.native_enqueue_revision IS NULL OR NEW.key_digest IS NULL)
  THEN
    RAISE EXCEPTION 'Incomplete public-filter home receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_key_generation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_key_generation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.enrollment_generation IS DISTINCT FROM OLD.enrollment_generation THEN
    RAISE EXCEPTION 'Original Source key enrollment generation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_population_start(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_population_start() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE observation_state text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Original population starts are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Erasure uses the original observation's admission lock. Unknown users,
  -- physical copies or children retain this cut, including expired leases.
  SELECT state INTO observation_state FROM search.public_filter_observation
    WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation) FOR UPDATE;
  IF observation_state IS NULL OR observation_state NOT IN ('closing','closed')
    OR EXISTS(SELECT 1 FROM search.public_filter_reference
      WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
    OR EXISTS(SELECT 1 FROM search.public_filter_pit
      WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation))
    OR EXISTS(SELECT 1 FROM search.public_filter_execution
      WHERE (partition_no,observation)=(OLD.partition_no,OLD.observation)) THEN
    RAISE EXCEPTION 'Original population start is still in use' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;


--
-- Name: retain_public_filter_repair_ack(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_repair_ack() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (OLD.verified_home IS NOT NULL AND NEW.verified_home IS DISTINCT FROM OLD.verified_home)
    OR NEW.ack_after<OLD.ack_after OR NEW.ack_after>OLD.ack_after+1
    OR (NEW.ack_after<>OLD.ack_after AND
      (NOT OLD.complete OR OLD.verified_root IS NULL OR OLD.verified_next IS NOT NULL)) THEN
    RAISE EXCEPTION 'Original repair window and contiguous ACK progress cannot be replaced'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_repair_verification(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.retain_public_filter_repair_verification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent semantic.public_filter_repair_step;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Original public-filter repair pages are immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.partition_no,NEW.bootstrap,NEW.execution,NEW.step,NEW.predecessor,NEW.state,
      NEW.complete,NEW.input_limit,NEW.receipt_protocol,NEW.repair_locator_digests)
    IS DISTINCT FROM
     (OLD.partition_no,OLD.bootstrap,OLD.execution,OLD.step,OLD.predecessor,OLD.state,
      OLD.complete,OLD.input_limit,OLD.receipt_protocol,OLD.repair_locator_digests) OR
    (OLD.verified_root IS NOT NULL AND
      (NEW.verified_binding,NEW.verified_root,NEW.verified_ordinal)
      IS DISTINCT FROM (OLD.verified_binding,OLD.verified_root,OLD.verified_ordinal)) OR
    (OLD.verified_next IS NOT NULL AND NEW.verified_next IS DISTINCT FROM OLD.verified_next) OR
    (OLD.complete AND NEW.verified_next IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Original public-filter repair evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.verified_root IS NOT NULL AND OLD.verified_root IS NULL THEN
    IF NEW.predecessor IS NULL THEN
      IF NEW.verified_ordinal<>1 THEN
        RAISE EXCEPTION 'Repair verification must begin at its original root' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT complete,verified_root,verified_binding,verified_next,verified_ordinal
      INTO parent.complete,parent.verified_root,parent.verified_binding,parent.verified_next,parent.verified_ordinal
      FROM semantic.public_filter_repair_step
      WHERE (partition_no,bootstrap,execution,step)=
        (NEW.partition_no,NEW.bootstrap,NEW.execution,NEW.predecessor);
      IF NOT FOUND OR parent.complete OR parent.verified_root IS NULL OR
        parent.verified_binding IS DISTINCT FROM NEW.verified_binding OR
        parent.verified_next IS DISTINCT FROM NEW.step OR
        NEW.verified_ordinal<>parent.verified_ordinal+1 THEN
        RAISE EXCEPTION 'Repair verification requires its contiguous original predecessor'
          USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF NEW.verified_next IS NOT NULL AND OLD.verified_next IS NULL AND NOT EXISTS (
    SELECT 1 FROM semantic.public_filter_repair_step s
    WHERE (s.partition_no,s.bootstrap,s.execution,s.step,s.predecessor)=
      (NEW.partition_no,NEW.bootstrap,NEW.execution,NEW.verified_next,NEW.step)) THEN
    RAISE EXCEPTION 'Repair verification cannot branch or skip an original page' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: seal_record_source_set(integer, uuid, integer); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.seal_record_source_set(p_home integer, p_tx uuid, p_revision integer) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE owner semantic.record_source_set; member semantic.record_source_set_member; native_route integer;
 native_body jsonb; n integer; calculated text;
BEGIN
 SELECT * INTO STRICT owner FROM semantic.record_source_set
 WHERE partition_no=p_home AND transaction_id=p_tx AND revision=p_revision FOR UPDATE;
 IF owner.sealed OR owner.native_xid<>pg_current_xact_id()::text THEN
  RAISE EXCEPTION 'Semantic record source set is not building';
 END IF;
 -- Resolve each actual version once. A point reference to an original document does not
 -- assert that its entire containing snapshot was copied by this command.
 FOR member IN SELECT DISTINCT ON(subject_id,candidate_id,source_revision,field,language) *
  FROM semantic.record_source_set_member WHERE partition_no=p_home AND transaction_id=p_tx
  ORDER BY subject_id,candidate_id,source_revision,field,language,document_id NULLS FIRST LOOP
  native_route:=(get_byte(uuid_send(member.subject_id),10)*256+get_byte(uuid_send(member.subject_id),11));
  IF native_route/16<>p_home THEN RAISE EXCEPTION 'Semantic source is outside native command home'; END IF;
  IF member.kind='contribution' THEN
   SELECT c.statement INTO native_body FROM semantic.candidate c WHERE c.route=native_route
    AND c.subject_id=member.subject_id AND c.candidate_id=member.candidate_id AND c.revision=member.source_revision;
   IF NOT FOUND THEN
    SELECT f.body INTO native_body FROM semantic.fact f JOIN semantic.revision r
      ON r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
    WHERE f.route=native_route AND f.subject_id=member.subject_id AND f.statement_id=member.candidate_id
      AND f.kind='statement' AND f.operation='assert' AND r.revision=member.source_revision LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown native Semantic contribution source'; END IF;
   END IF;
   IF EXISTS(
    WITH expected AS MATERIALIZED (
     SELECT value #>> '{}' AS id FROM jsonb_path_query(native_body,'$.value.content.document') AS document(value)
     UNION SELECT value #>> '{}' FROM jsonb_path_query(native_body,'$.qualifiers[*].value.content.document') AS document(value)
     UNION SELECT value #>> '{}' FROM jsonb_path_query(native_body,'$.references[*].parts[*].value.content.document') AS document(value)
    ), collected AS MATERIALIZED (
     SELECT document_id::text AS id FROM semantic.record_source_set_member m
     WHERE m.partition_no=p_home AND m.transaction_id=p_tx AND m.kind='contribution'
      AND m.subject_id=member.subject_id AND m.candidate_id=member.candidate_id
      AND m.source_revision=member.source_revision AND m.document_id IS NOT NULL
    )
    SELECT 1 FROM (
     (SELECT id FROM expected WHERE member.document_id IS NULL EXCEPT SELECT id FROM collected)
     UNION ALL (SELECT id FROM collected EXCEPT SELECT id FROM expected)) mismatch
   ) THEN RAISE EXCEPTION 'Semantic contribution source omitted or invented a native document'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM semantic.fact f JOIN semantic.revision r
    ON r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
    WHERE f.route=native_route AND f.subject_id=member.subject_id AND r.revision=member.source_revision
      AND f.kind=CASE member.field WHEN 'labels' THEN 'label' WHEN 'descriptions' THEN 'description' ELSE 'alias' END
      AND f.language=member.language) THEN RAISE EXCEPTION 'Unknown native Semantic term source'; END IF;
  END IF;
 END LOOP;
 SELECT count(DISTINCT unit_key),encode(sha256(convert_to(coalesce(string_agg(source_key,E'\n' ORDER BY source_key),''),'UTF8')),'hex')
 INTO n,calculated FROM semantic.record_source_set_member WHERE partition_no=p_home AND transaction_id=p_tx;
 UPDATE semantic.record_source_set SET sealed=true,members=n,digest=calculated
 WHERE partition_no=p_home AND transaction_id=p_tx;
END; $_$;


--
-- Name: erasure_record_key; Type: SEQUENCE; Schema: semantic; Owner: -
--

CREATE SEQUENCE semantic.erasure_record_key
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: adoption; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.adoption (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    context_id uuid NOT NULL,
    head integer NOT NULL,
    mode text NOT NULL,
    selection jsonb NOT NULL,
    revision integer NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT adoption_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT adoption_head_check CHECK ((head >= 1)),
    CONSTRAINT adoption_mode_check CHECK ((mode = ANY (ARRAY['inherit'::text, 'replace'::text, 'suppress'::text]))),
    CONSTRAINT adoption_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT adoption_selection_check CHECK ((jsonb_typeof(selection) = 'array'::text)),
    CONSTRAINT adoption_selection_check1 CHECK ((jsonb_array_length(selection) <= 32)),
    CONSTRAINT adoption_selection_check2 CHECK ((NOT jsonb_path_exists(selection, '$[*]?(@."candidate".type() != "string" || @."rank" != "normal" && @."rank" != "preferred")'::jsonpath))),
    CONSTRAINT adoption_selection_check3 CHECK ((NOT jsonb_path_exists(selection, '$[*]?(!(exists (@."candidate")) || !(exists (@."rank")))'::jsonpath))),
    CONSTRAINT adoption_selection_objects_check CHECK ((NOT jsonb_path_exists(selection, 'strict $[*]?(@.type() != "object")'::jsonpath)))
);


--
-- Name: search_project_adoption(semantic.adoption); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.search_project_adoption(a semantic.adoption) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF a.context_id <> '00000000-0000-8000-8000-000000000000'::uuid THEN RETURN; END IF;
  INSERT INTO semantic.search_selection_slot (route, subject_id, slot_id, expanded, head)
    VALUES (a.route, a.subject_id, a.slot_id, true, a.head)
    ON CONFLICT (route, subject_id, slot_id) DO UPDATE SET expanded = true, head = EXCLUDED.head
      WHERE semantic.search_selection_slot.head < EXCLUDED.head;
  IF NOT FOUND THEN RETURN; END IF;
  DELETE FROM semantic.search_selected WHERE route = a.route AND subject_id = a.subject_id AND slot_id = a.slot_id;
  IF a.mode <> 'replace' THEN RETURN; END IF;
  INSERT INTO semantic.search_selected
    (route, subject_id, slot_id, candidate_id, property, rank, ordinal, body, release, revision, source,
      relation, compact, active, log_seq)
    SELECT a.route, a.subject_id, a.slot_id, c.candidate_id, c.property, e.body->>'rank', e.ordinal,
      c.statement, c.release, c.revision, r.source, c.relation, false, true, 0
    FROM jsonb_array_elements(a.selection) WITH ORDINALITY AS e(body, ordinal)
    JOIN semantic.candidate c ON c.route = a.route AND c.subject_id = a.subject_id AND c.slot_id = a.slot_id
      AND c.candidate_id = (e.body->>'candidate')::uuid
    JOIN semantic.revision r ON r.route = a.route AND r.subject_id = a.subject_id AND r.revision = c.revision;
END;
$$;


--
-- Name: fact; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.fact (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    log_seq integer NOT NULL,
    operation text NOT NULL,
    kind text NOT NULL,
    language text,
    property text,
    statement_id uuid,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    release text,
    relation boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT fact_check CHECK ((((operation = 'expand'::text) AND (kind = 'statement'::text) AND (language IS NULL) AND (property IS NOT NULL) AND (statement_id IS NULL) AND (body = '{}'::jsonb)) OR ((operation <> 'expand'::text) AND (((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text])) AND (language IS NOT NULL) AND (property IS NULL) AND (statement_id IS NULL)) OR ((kind = 'statement'::text) AND (language IS NULL) AND (property IS NOT NULL) AND (statement_id IS NOT NULL)))))),
    CONSTRAINT fact_kind_check CHECK ((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text, 'statement'::text]))),
    CONSTRAINT fact_log_seq_check CHECK ((((log_seq >= 1) AND (log_seq <= 33)) AND ((log_seq <> 33) OR (operation = 'expand'::text)))),
    CONSTRAINT fact_operation_check CHECK ((operation = ANY (ARRAY['assert'::text, 'retract'::text, 'expand'::text]))),
    CONSTRAINT fact_release_check CHECK ((((kind = 'statement'::text) AND (operation = 'assert'::text)) = (release IS NOT NULL))),
    CONSTRAINT fact_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
);


--
-- Name: search_project_fact(semantic.fact); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.search_project_fact(f semantic.fact) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE expanded_slot boolean; r semantic.revision%ROWTYPE;
BEGIN
  IF f.kind <> 'statement' THEN RETURN; END IF;
  INSERT INTO semantic.search_selection_slot (route, subject_id, slot_id)
    VALUES (f.route, f.subject_id, f.slot_id) ON CONFLICT DO NOTHING;
  IF f.operation = 'expand' THEN
    UPDATE semantic.search_selection_slot SET expanded = true
      WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id;
    DELETE FROM semantic.search_selected WHERE route = f.route AND subject_id = f.subject_id
      AND slot_id = f.slot_id AND compact;
    RETURN;
  END IF;
  SELECT expanded INTO expanded_slot FROM semantic.search_selection_slot
    WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id;
  IF expanded_slot THEN RETURN; END IF;
  IF f.operation = 'retract' THEN
    INSERT INTO semantic.search_selection_retraction VALUES (f.route, f.subject_id, f.slot_id, f.statement_id, f.log_seq)
      ON CONFLICT (route, subject_id, slot_id, candidate_id) DO UPDATE
        SET log_seq = greatest(semantic.search_selection_retraction.log_seq, EXCLUDED.log_seq);
    UPDATE semantic.search_selected SET active = false, log_seq = f.log_seq
      WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id
        AND candidate_id = f.statement_id AND log_seq < f.log_seq;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM semantic.search_selection_retraction WHERE route = f.route AND subject_id = f.subject_id
    AND slot_id = f.slot_id AND candidate_id = f.statement_id AND log_seq >= f.log_seq) THEN RETURN; END IF;
  IF f.body->>'rank' NOT IN ('normal', 'preferred') THEN
    UPDATE semantic.search_selected SET active = false, log_seq = f.log_seq
      WHERE route = f.route AND subject_id = f.subject_id AND slot_id = f.slot_id
        AND candidate_id = f.statement_id AND log_seq < f.log_seq;
    RETURN;
  END IF;
  SELECT * INTO STRICT r FROM semantic.revision WHERE route = f.route AND subject_id = f.subject_id
    AND recorded_transaction_id = f.recorded_transaction_id;
  INSERT INTO semantic.search_selected
    (route, subject_id, slot_id, candidate_id, property, rank, ordinal, body, release, revision, source,
      relation, compact, active, log_seq)
    VALUES (f.route, f.subject_id, f.slot_id, f.statement_id, f.property, f.body->>'rank', f.log_seq,
      f.body, f.release, r.revision, r.source, f.relation, true, true, f.log_seq)
    ON CONFLICT (route, subject_id, slot_id, candidate_id) DO UPDATE
      SET active = true, log_seq = EXCLUDED.log_seq, body = EXCLUDED.body, rank = EXCLUDED.rank,
          ordinal = EXCLUDED.ordinal, release = EXCLUDED.release, revision = EXCLUDED.revision, source = EXCLUDED.source
      WHERE semantic.search_selected.log_seq < EXCLUDED.log_seq;
END;
$$;


--
-- Name: search_project_insert(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.search_project_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE f semantic.fact%ROWTYPE; a semantic.adoption%ROWTYPE;
BEGIN
  INSERT INTO semantic.search_selection_state (route, subject_id)
    VALUES (NEW.route, NEW.subject_id) ON CONFLICT DO NOTHING;
  -- Serialize cold folding against only this source's native maintenance, never other homes.
  PERFORM 1 FROM semantic.search_selection_state WHERE route = NEW.route AND subject_id = NEW.subject_id FOR UPDATE;
  IF TG_ARGV[0] = 'fact' THEN f := NEW; PERFORM semantic.search_project_fact(f);
  ELSE a := NEW; PERFORM semantic.search_project_adoption(a); END IF;
  RETURN NEW;
END;
$$;


--
-- Name: search_project_subject(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.search_project_subject() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO semantic.search_selection_state (route, subject_id, ready, phase)
    VALUES (NEW.route, NEW.subject_id, true, 'done');
  RETURN NEW;
END;
$$;


--
-- Name: search_rebuild_one(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.search_rebuild_one(r integer, s uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE state semantic.search_selection_state%ROWTYPE; f semantic.fact%ROWTYPE; a semantic.adoption%ROWTYPE;
BEGIN
  INSERT INTO semantic.search_selection_state (route, subject_id)
    SELECT r, s FROM semantic.subject WHERE route = r AND subject_id = s ON CONFLICT DO NOTHING;
  SELECT * INTO state FROM semantic.search_selection_state WHERE route = r AND subject_id = s FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF state.ready THEN RETURN true; END IF;
  IF state.phase = 'facts' THEN
    SELECT * INTO f FROM semantic.fact WHERE route = r AND subject_id = s AND kind = 'statement'
      AND (slot_id, log_seq) > (state.after_slot, state.after_seq) ORDER BY slot_id, log_seq LIMIT 1;
    IF FOUND THEN
      PERFORM semantic.search_project_fact(f);
      UPDATE semantic.search_selection_state SET after_slot = f.slot_id, after_seq = f.log_seq WHERE route = r AND subject_id = s;
      RETURN false;
    END IF;
    UPDATE semantic.search_selection_state SET phase = 'adoptions', after_slot = '00000000-0000-0000-0000-000000000000',
      after_seq = 0 WHERE route = r AND subject_id = s;
    RETURN false;
  END IF;
  SELECT * INTO a FROM semantic.adoption WHERE route = r AND subject_id = s
    AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
    AND (slot_id, head) > (state.after_slot, state.after_seq) ORDER BY slot_id, head LIMIT 1;
  IF FOUND THEN
    PERFORM semantic.search_project_adoption(a);
    UPDATE semantic.search_selection_state SET after_slot = a.slot_id, after_seq = a.head WHERE route = r AND subject_id = s;
    RETURN false;
  END IF;
  UPDATE semantic.search_selection_state SET ready = true, phase = 'done' WHERE route = r AND subject_id = s;
  RETURN true;
END;
$$;


--
-- Name: subject_page_bootstrap_population(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.subject_page_bootstrap_population() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.visible>0 AND (TG_OP='INSERT' OR OLD.visible=0) THEN
    UPDATE semantic.subject_page_bootstrap
    SET version=version+1, source_key=NULL, state='pending', available_at=now(), worker=NULL, lease_until=NULL
    WHERE partition_no=NEW.partition_no AND state='done';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: subject_page_valid_witnesses(jsonb); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.subject_page_valid_witnesses(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT jsonb_typeof(value) = 'array' AND jsonb_array_length(value) <= 8
    AND (SELECT count(*) = count(DISTINCT (entry->>'kind', entry->>'key'))
         AND coalesce(bool_and(coalesce(entry->>'kind' IN ('fact','cover','relation')
             AND jsonb_typeof(entry->'key') = 'string', false)), true)
         FROM jsonb_array_elements(value) entry)
$$;


--
-- Name: subject_page_work_home_changed(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.subject_page_work_home_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE home integer; delta integer;
BEGIN
  IF TG_TABLE_NAME='subject_page_bootstrap' THEN home := NEW.partition_no; ELSE home := NEW.route >> 4; END IF;
  delta := CASE WHEN NEW.state<>'done' THEN 1 ELSE 0 END;
  IF TG_OP='UPDATE' THEN delta := delta-CASE WHEN OLD.state<>'done' THEN 1 ELSE 0 END; END IF;
  IF delta<>0 THEN UPDATE semantic.subject_page_work_home SET pending=pending+delta WHERE partition_no=home; END IF;
  RETURN NEW;
END $$;


--
-- Name: validate_context_role_enrollment(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_context_role_enrollment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM editorial.write_basis b JOIN core.partition p USING(partition_no)
   WHERE b.partition_no=NEW.route/16 AND b.transaction_id=NEW.enrollment_transaction
     AND b.epoch=NEW.epoch AND b.position=NEW.position AND p.epoch=b.epoch
     AND p.position=b.position AND p.write_state='active' AND b.xmin::text=pg_current_xact_id()::text)
 OR NOT EXISTS(SELECT 1 FROM editorial.write_basis b
   WHERE b.partition_no=NEW.route/16 AND b.transaction_id=NEW.source_transaction)
 OR (NEW.grant_transaction IS NOT NULL AND NOT EXISTS(SELECT 1 FROM editorial.write_basis b
   WHERE b.partition_no=NEW.route/16 AND b.transaction_id=NEW.grant_transaction)) THEN
  RAISE EXCEPTION 'Context role enrollment lacks native same-home command provenance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: validate_erasure_source_commit(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_erasure_source_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM editorial.write_basis b
   WHERE b.partition_no=NEW.partition_no AND b.transaction_id=NEW.transaction_id
     AND b.epoch=NEW.epoch AND b.position=NEW.position AND b.xmin::text=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'Semantic Source receipt lacks same-command native custody' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: validate_identity_binding_consumer_birth(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_identity_binding_consumer_birth() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.generation=OLD.generation THEN RETURN NEW; END IF;
 IF NEW.consumer_undo_generation IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM semantic.identity_epoch_receipt_claim c
  JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no
   AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin AND n.xmin=c.xmin
  WHERE c.partition_no=NEW.partition_no AND c.receipt_key=NEW.receipt_key AND c.generation=NEW.generation
   AND c.transaction_id=n.transaction_id AND n.transaction_id=NEW.consumer_undo_transaction_id
   AND c.xmin=pg_current_xact_id()::xid AND NEW.consumer_undo_generation=0
 ) THEN RAISE EXCEPTION 'identity_consumer_birth_not_native'; END IF;
 RETURN NEW;
END $$;


--
-- Name: validate_identity_scope_consumer_fence(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_identity_scope_consumer_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM semantic.identity_scope_summary s
  JOIN semantic.identity_scope_attempt a USING(partition_no,source_key,scope_id,registration)
  JOIN semantic.identity_scope_completion c USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=s.partition_no
   AND n.transaction_id=NEW.transaction_id AND n.epoch=NEW.native_epoch
   AND n.position=NEW.native_position AND n.purpose='identity-scope-finish'
  JOIN semantic.identity_scope_consumer_fence f ON f.partition_no=NEW.partition_no
   AND f.source_key=NEW.source_key AND f.scope_id=NEW.scope_id AND f.registration=NEW.registration
   AND f.job_id=NEW.job_id AND f.job_epoch=NEW.job_epoch AND f.xmin=n.xmin
  JOIN semantic.identity_epoch_native_commit completed ON completed.partition_no=a.partition_no
   AND completed.transaction_id=a.transaction_id AND completed.purpose='identity-scope-finish'
   AND completed.xmin=a.xmin AND completed.xmin=c.xmin
   AND completed.epoch=n.epoch AND completed.position<n.position
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
   AND p.position>=n.position AND p.write_state='active' AND p.moved_to IS NULL
  WHERE s.partition_no=NEW.partition_no AND s.source_key=NEW.source_key AND s.scope_id=NEW.scope_id
   AND s.registration=NEW.registration AND s.capture_id=NEW.capture_id
   AND s.source->>'kind'='library' AND s.source->'identity'->>'scope'<>'public_output'
   AND (s.source->'identity'->>'ownerEpoch')::integer=n.epoch
   AND s.capture->>'kind'='library' AND s.scan_complete AND s.frontier->>'driver'='done'
   AND s.active=0 AND s.state IN ('ready','repair') AND a.state='finished' AND c.complete
   AND a.job_id=NEW.job_id AND a.job_epoch=NEW.job_epoch AND a.attempt=NEW.attempt
   AND c.capture_id=NEW.capture_id AND c.attempt=NEW.attempt
   AND c.source_generation=NEW.source_generation AND c.version=NEW.completion_version
   AND c.seal IS NOT NULL
 ) THEN RAISE EXCEPTION 'identity_scope_consumer_fence_not_native' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: validate_public_filter_creation_pin(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_public_filter_creation_pin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.complete AND (TG_OP='INSERT' OR OLD.receipt IS NULL) AND
    (NEW.creation_consumer IS DISTINCT FROM 'public_filter_' || replace(NEW.bootstrap::text,'-','')
      OR NOT EXISTS (
        SELECT 1 FROM core.consumer_checkpoint c
        WHERE c.partition_no=NEW.partition_no AND c.consumer=NEW.creation_consumer
          AND c.position<=NEW.creation_position
          AND (c.epoch IS NULL OR c.epoch=NEW.owner_epoch))) THEN
    RAISE EXCEPTION 'Original public-filter baseline requires its creation retention pin'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: validate_public_filter_repair_advance(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_public_filter_repair_advance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.transaction_id IS NULL OR NEW.native_xid IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS (
      SELECT 1 FROM core.partition p
      WHERE p.partition_no = NEW.partition_no AND p.epoch = NEW.owner_epoch
        AND p.position = NEW.position AND p.write_state = 'active'
        AND p.xmin = pg_current_xact_id()::xid
    ) OR NOT EXISTS (
      SELECT 1 FROM core.outbox e
      WHERE e.partition_no = NEW.partition_no AND e.position = NEW.position
        AND e.epoch = NEW.owner_epoch AND e.event_seq = 0 AND e.event_count = 1
        AND e.type = 'com.rezics.semantic.public-source.advanced.v1'
        AND e.subject = NEW.subject_id::text
        AND e.data = jsonb_build_object('id',NEW.subject_id::text,
          'bootstrap',NEW.bootstrap::text,'execution',NEW.execution)
        AND e.xmin = pg_current_xact_id()::xid
    ) THEN
    RAISE EXCEPTION 'Public Source advancement lacks original same-command native custody'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: validate_public_output_accepted_binding(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_public_output_accepted_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM library.native_public_output_binding b
  JOIN semantic.identity_public_output_gate g ON g.partition_no=b.partition_no AND g.capture_id=b.capture_id
  WHERE b.partition_no=NEW.partition_no AND b.capture_id=NEW.capture_id AND b.hold_id=NEW.hold_id
   AND b.payload=NEW.binding AND b.binding_digest=NEW.binding_digest AND b.definition_digest=NEW.definition_digest
   AND b.xmin=pg_current_xact_id()::text::xid AND b.native_xid=pg_current_xact_id() AND g.xmin=b.xmin
   AND g.original_epoch=b.receiving_epoch AND g.receiving_epoch=b.receiving_epoch AND g.state='open' AND g.enrolled_count=0)
 THEN RAISE EXCEPTION 'public_output_accepted_requires_native_binding_and_gate'; END IF;
 RETURN NULL;
END $$;


--
-- Name: validate_public_output_gate_close(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_public_output_gate_close() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.state='open' THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_fence f
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=f.partition_no AND n.transaction_id=f.transaction_id
   AND n.epoch=f.native_epoch AND n.position=f.native_position
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position=n.position
  JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position AND o.event_seq=0
  JOIN semantic.identity_public_output_gate g ON g.partition_no=f.partition_no AND g.capture_id=f.capture_id
  WHERE g.partition_no=NEW.partition_no AND g.capture_id=NEW.capture_id AND g.state=f.kind
   AND g.native_epoch=f.native_epoch AND g.native_position=f.native_position AND g.transaction_id=f.transaction_id
   AND g.xmin=f.xmin AND g.xmin=n.xmin AND n.xmin=o.xmin AND g.native_xid=pg_current_xact_id()
   AND g.receiving_epoch=g.original_epoch+1 AND p.write_state='active' AND p.moved_to IS NULL
   AND n.purpose=CASE f.kind WHEN 'applied' THEN 'identity-public-output-applied' ELSE 'identity-public-output-cancelled' END
   AND o.type='com.rezics.semantic.public-output.capture.v1')
 THEN RAISE EXCEPTION 'public_output_gate_requires_native_fence'; END IF;
 RETURN NULL;
END $$;


--
-- Name: validate_public_output_gate_origin(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_public_output_gate_origin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM semantic.identity_public_output_accepted a
  JOIN library.native_public_output_binding b USING(partition_no,capture_id)
  JOIN semantic.identity_public_output_gate g USING(partition_no,capture_id)
  WHERE a.partition_no=NEW.partition_no AND a.capture_id=NEW.capture_id
   AND a.xmin=b.xmin AND a.xmin=g.xmin AND b.native_xid=pg_current_xact_id()
   AND g.state='open' AND g.original_epoch=b.receiving_epoch AND g.receiving_epoch=b.receiving_epoch AND g.enrolled_count=0)
 THEN RAISE EXCEPTION 'public_output_gate_requires_original_acceptance'; END IF;
 RETURN NULL;
END $$;


--
-- Name: validate_public_output_native(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_public_output_native() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE expected text;
BEGIN
 expected:=CASE TG_TABLE_NAME WHEN 'identity_public_output_subject_cut' THEN 'identity-scope-enrollment'
  WHEN 'identity_public_output_subject_release' THEN 'identity-scope-directory-release'
  WHEN 'identity_public_output_fence' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  WHEN 'identity_public_output_disposition' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  WHEN 'identity_public_output_transition' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  WHEN 'identity_public_output_stage' THEN 'identity-public-output-' || (to_jsonb(NEW)->>'kind')
  ELSE 'identity-public-output-capture' END;
 IF NOT EXISTS (SELECT 1 FROM semantic.identity_epoch_native_commit n
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position=n.position
  JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position AND o.event_seq=0
  WHERE (n.partition_no,n.transaction_id,n.epoch,n.position)=
   (NEW.partition_no,NEW.transaction_id,NEW.native_epoch,NEW.native_position)
   AND n.purpose=expected AND n.xmin=pg_current_xact_id()::text::xid AND o.xmin=n.xmin
   AND p.write_state='active' AND p.moved_to IS NULL AND o.type='com.rezics.semantic.public-output.capture.v1')
 THEN RAISE EXCEPTION 'public_output_capture_not_native' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: validate_public_output_transition(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_public_output_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM semantic.identity_public_output_stage s
  JOIN semantic.identity_public_output_disposition d USING(partition_no,capture_id,hold_id,binding_digest,kind,native_epoch,native_position,transaction_id)
  JOIN semantic.identity_public_output_transition t USING(partition_no,capture_id,kind,native_epoch,native_position,transaction_id)
  JOIN semantic.identity_public_output_accepted a USING(partition_no,capture_id)
  JOIN semantic.identity_public_output_gate g USING(partition_no,capture_id)
  JOIN library.native_public_output_transition nt ON nt.partition_no=s.partition_no AND nt.capture_id=s.capture_id
   AND nt.hold_id=s.hold_id AND nt.binding_digest=s.binding_digest AND nt.transaction_id=s.transaction_id
   AND nt.epoch=s.native_epoch AND nt.position=s.native_position AND nt.kind=s.kind AND nt.purpose=s.purpose
  JOIN library.native_public_output_hold h ON h.partition_no=s.partition_no AND h.hold_id=s.hold_id
  JOIN library.native_public_output_receiving r ON r.partition_no=s.partition_no AND r.capture_id=s.capture_id
  LEFT JOIN library.native_public_output_hold k ON k.partition_no=s.partition_no AND k.hold_id=s.successor_hold_id
  LEFT JOIN semantic.identity_public_output_seal seal ON seal.partition_no=s.partition_no AND seal.capture_id=s.capture_id
  JOIN semantic.identity_public_output_progress progress ON progress.partition_no=s.partition_no AND progress.capture_id=s.capture_id
  WHERE s.partition_no=NEW.partition_no AND s.capture_id=NEW.capture_id AND s.native_xid=pg_current_xact_id()
   AND s.xmin=d.xmin AND s.xmin=t.xmin AND s.xmin=nt.xmin AND nt.native_xid=s.native_xid
   AND a.hold_id=s.hold_id AND a.binding_digest=s.binding_digest AND a.native_epoch=s.native_epoch
   AND s.original_receiving_epoch=(a.binding->'tuple'->'identity'->>'receivingEpoch')::bigint
   AND g.state=s.kind AND g.enrolled_count=0 AND g.receiving_epoch=s.original_receiving_epoch+1
   AND r.state=s.kind AND r.receiving_epoch=g.receiving_epoch AND r.transaction_id=s.transaction_id
   AND h.role='predecessor' AND h.consumed_by=s.transaction_id AND h.xmin=s.xmin
   AND t.successor_hold_id IS NOT DISTINCT FROM s.successor_hold_id
   AND nt.successor_hold_id IS NOT DISTINCT FROM s.successor_hold_id
   AND d.manifest_digest IS NOT DISTINCT FROM s.manifest_digest AND d.seal_transaction_id IS NOT DISTINCT FROM s.seal_transaction_id
   AND ((s.kind='applied' AND k.role='successor' AND k.capture_id=s.capture_id AND k.consumed_by IS NULL
     AND k.transaction_id=s.transaction_id AND k.native_xid=s.native_xid AND k.xmin=s.xmin
     AND seal.manifest_digest=s.manifest_digest AND seal.transaction_id=s.seal_transaction_id)
    OR (s.kind='cancelled' AND nt.cancellation_epoch=s.cancellation_epoch
      AND s.cancellation_epoch=g.receiving_epoch
      AND progress.closure_after>=progress.version+CASE WHEN progress.pending IS NULL THEN 0 ELSE 1 END)))
 THEN RAISE EXCEPTION 'public_output_disposition_without_atomic_transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: validate_record_deletion_commit(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.validate_record_deletion_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: acceptance; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.acceptance (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    head integer NOT NULL,
    verdict text NOT NULL,
    revision integer NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT acceptance_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT acceptance_head_check CHECK ((head >= 1)),
    CONSTRAINT acceptance_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT acceptance_verdict_check CHECK ((verdict = ANY (ARRAY['accept'::text, 'reject'::text, 'abstain'::text])))
);


--
-- Name: acceptance_current; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.acceptance_current (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    head integer NOT NULL,
    verdict text NOT NULL,
    revision integer NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT acceptance_current_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT acceptance_current_head_check CHECK ((head >= 1)),
    CONSTRAINT acceptance_current_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT acceptance_current_verdict_check CHECK ((verdict = ANY (ARRAY['accept'::text, 'reject'::text, 'abstain'::text])))
);


--
-- Name: account_agent_moved_link; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.account_agent_moved_link (
    route integer NOT NULL,
    receipt_id text NOT NULL,
    account_id uuid NOT NULL,
    survivor uuid NOT NULL,
    moved_from uuid NOT NULL,
    statement_id uuid NOT NULL,
    property text NOT NULL,
    source_subject_id uuid NOT NULL,
    filter_value uuid NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    source_revision integer,
    source_security_revision bigint,
    present boolean,
    source_type text,
    order_key text,
    reversal_prepared boolean DEFAULT false NOT NULL,
    reversed boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT account_agent_moved_link_receipt_check CHECK (((length(receipt_id) >= 1) AND (length(receipt_id) <= 255)))
);


--
-- Name: account_agent_subject; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.account_agent_subject (
    route integer NOT NULL,
    account_route integer NOT NULL,
    subject_id uuid NOT NULL,
    account_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    receipt_id text,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT account_agent_subject_account_route_check CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_agent_subject_receipt_check CHECK (((verified AND (receipt_id IS NOT NULL) AND ((length(receipt_id) >= 1) AND (length(receipt_id) <= 255))) OR ((NOT verified) AND (receipt_id IS NULL)))),
    CONSTRAINT account_agent_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
);


--
-- Name: candidate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.candidate (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    property text NOT NULL,
    rank text NOT NULL,
    statement jsonb NOT NULL,
    release text NOT NULL,
    revision integer NOT NULL,
    origin text NOT NULL,
    view_order integer DEFAULT 0 NOT NULL,
    relation boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    erasure_private boolean DEFAULT false NOT NULL,
    CONSTRAINT candidate_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT candidate_check1 CHECK ((route = ((get_byte(uuid_send(candidate_id), 10) * 256) + get_byte(uuid_send(candidate_id), 11)))),
    CONSTRAINT candidate_origin_check CHECK ((origin = ANY (ARRAY['compact'::text, 'proposal'::text]))),
    CONSTRAINT candidate_rank_check CHECK ((rank = ANY (ARRAY['normal'::text, 'preferred'::text]))),
    CONSTRAINT candidate_release_check CHECK ((release ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT candidate_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT candidate_statement_check CHECK ((jsonb_typeof(statement) = 'object'::text)),
    CONSTRAINT candidate_view_order_check CHECK (((view_order >= 0) AND (view_order <= 32)))
);


--
-- Name: context; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context (
    route integer NOT NULL,
    context_id uuid NOT NULL,
    kind text NOT NULL,
    labels jsonb NOT NULL,
    recorded_transaction_id uuid,
    settings_id text,
    settings_release text,
    defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    deleted_at timestamp with time zone,
    purge_after timestamp with time zone,
    security_revision bigint DEFAULT 0 NOT NULL,
    held boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    directory_pending boolean DEFAULT true NOT NULL,
    deletion_generation uuid,
    deletion_transaction_id uuid,
    CONSTRAINT context_check CHECK ((route = ((get_byte(uuid_send(context_id), 10) * 256) + get_byte(uuid_send(context_id), 11)))),
    CONSTRAINT context_defaults_check CHECK (((jsonb_typeof(defaults) = 'object'::text) AND (NOT jsonb_path_exists(defaults, '$.*?(@ != "inherit" && @ != "suppress")'::jsonpath)))),
    CONSTRAINT context_global_active CHECK (((kind <> 'global'::text) OR (state = 'active'::text))),
    CONSTRAINT context_kind_check CHECK ((kind = ANY (ARRAY['global'::text, 'community'::text]))),
    CONSTRAINT context_lifecycle_window CHECK ((((deleted_at IS NULL) AND (purge_after IS NULL) AND (state = 'active'::text)) OR ((deleted_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (purge_after = (deleted_at + '720:00:00'::interval))))),
    CONSTRAINT context_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT context_security_revision_check CHECK ((security_revision >= 0)),
    CONSTRAINT context_settings_id_check CHECK (((settings_id IS NULL) OR (settings_id ~ '^[a-z][a-z0-9-]{0,63}$'::text))),
    CONSTRAINT context_settings_pair_check CHECK (((settings_id IS NULL) = (settings_release IS NULL))),
    CONSTRAINT context_settings_release_check CHECK (((settings_release IS NULL) OR (settings_release ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT context_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text, 'purged'::text]))),
    CONSTRAINT context_without_settings_defaults_check CHECK (((settings_id IS NOT NULL) OR (defaults = '{}'::jsonb)))
);


--
-- Name: context_directory_entry; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context_directory_entry (
    route integer DEFAULT 0 NOT NULL,
    context_id uuid NOT NULL,
    language text NOT NULL,
    search_key text NOT NULL COLLATE pg_catalog."C",
    state text NOT NULL,
    source_epoch integer NOT NULL,
    source_version bigint NOT NULL,
    refresh_pending boolean DEFAULT false NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT context_directory_entry_route_check CHECK ((route = 0)),
    CONSTRAINT context_directory_entry_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text])))
);


--
-- Name: context_directory_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context_directory_home (
    route integer NOT NULL,
    partition_no integer NOT NULL,
    source_epoch integer NOT NULL,
    after_route integer NOT NULL,
    after_key bigint DEFAULT 0 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT context_directory_home_check CHECK ((route = (partition_no * 16))),
    CONSTRAINT context_directory_home_check1 CHECK (((after_route >= route) AND (after_route <= (route + 16)))),
    CONSTRAINT context_directory_home_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: context_extension; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context_extension (
    route integer NOT NULL,
    context_id uuid NOT NULL,
    digest text NOT NULL,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT context_extension_check CHECK ((route = ((get_byte(uuid_send(context_id), 10) * 256) + get_byte(uuid_send(context_id), 11)))),
    CONSTRAINT context_extension_digest_check CHECK ((digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT context_extension_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: context_extension_activation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context_extension_activation (
    route integer NOT NULL,
    context_id uuid NOT NULL,
    head integer NOT NULL,
    digest text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT context_extension_activation_head_check CHECK ((head >= 1)),
    CONSTRAINT context_extension_activation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: context_role_enrollment; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context_role_enrollment (
    route integer NOT NULL,
    occurrence bigint NOT NULL,
    context_key bigint NOT NULL,
    side text NOT NULL,
    grant_transaction uuid,
    source_transaction uuid NOT NULL,
    enrollment_transaction uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    CONSTRAINT context_role_enrollment_occurrence_check CHECK ((occurrence > 0)),
    CONSTRAINT context_role_enrollment_side_check CHECK ((side = ANY (ARRAY['creator'::text, 'new'::text, 'former'::text])))
);


--
-- Name: contribution_lifecycle; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.contribution_lifecycle (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    state text DEFAULT 'deleted'::text NOT NULL,
    deleted_at timestamp with time zone NOT NULL,
    purge_after timestamp with time zone NOT NULL,
    held boolean DEFAULT false NOT NULL,
    security_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT contribution_lifecycle_check CHECK ((purge_after = (deleted_at + '720:00:00'::interval))),
    CONSTRAINT contribution_lifecycle_check1 CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT contribution_lifecycle_check2 CHECK ((route = ((get_byte(uuid_send(candidate_id), 10) * 256) + get_byte(uuid_send(candidate_id), 11)))),
    CONSTRAINT contribution_lifecycle_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT contribution_lifecycle_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text, 'purged'::text])))
);


--
-- Name: term_head; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.term_head (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    kind text NOT NULL,
    language text NOT NULL,
    slot_id uuid NOT NULL,
    first_seq integer NOT NULL,
    support_transaction_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT term_head_first_seq_check CHECK ((first_seq >= 1)),
    CONSTRAINT term_head_kind_check CHECK ((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text])))
);


--
-- Name: current_term_fact; Type: VIEW; Schema: semantic; Owner: -
--

CREATE VIEW semantic.current_term_fact AS
 SELECT f.route,
    f.subject_id,
    f.slot_id,
    f.log_seq,
    f.operation,
    f.kind,
    f.language,
    f.property,
    f.statement_id,
    f.body,
    h.support_transaction_id AS recorded_transaction_id,
    f.release,
    f.relation,
    f.erasure_key
   FROM (semantic.term_head h
     JOIN semantic.fact f ON (((f.route = h.route) AND (f.subject_id = h.subject_id) AND (f.slot_id = h.slot_id) AND (f.log_seq >= h.first_seq))))
  WHERE (h.active AND (f.operation = 'assert'::text));


--
-- Name: definition_activation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_activation (
    route integer NOT NULL,
    head integer NOT NULL,
    digest text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT definition_activation_head_check CHECK ((head >= 1)),
    CONSTRAINT definition_activation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: definition_catalogue_activation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_activation (
    route integer NOT NULL,
    root_digest text NOT NULL,
    activation_id uuid NOT NULL,
    previous_root text,
    expected_head integer NOT NULL,
    state text DEFAULT 'ready'::text NOT NULL,
    closed_generation bigint,
    closed_sequence bigint,
    staged_sequence bigint DEFAULT 0 NOT NULL,
    recorded_transaction_id uuid CONSTRAINT definition_catalogue_activatio_recorded_transaction_id_not_null NOT NULL,
    native_position bigint DEFAULT 0 NOT NULL,
    CONSTRAINT definition_catalogue_activation_check CHECK (((previous_root IS NULL) OR (previous_root <> root_digest))),
    CONSTRAINT definition_catalogue_activation_check1 CHECK (((closed_sequence IS NULL) OR ((closed_sequence >= 0) AND (staged_sequence <= closed_sequence)))),
    CONSTRAINT definition_catalogue_activation_check2 CHECK (((state <> ALL (ARRAY['ready'::text, 'closing'::text])) OR (staged_sequence = 0))),
    CONSTRAINT definition_catalogue_activation_check3 CHECK ((((state = ANY (ARRAY['ready'::text, 'closing'::text])) AND (closed_generation IS NULL) AND (closed_sequence IS NULL)) OR ((state = ANY (ARRAY['invalidating'::text, 'active'::text])) AND (closed_generation IS NOT NULL) AND (closed_sequence IS NOT NULL)))),
    CONSTRAINT definition_catalogue_activation_closed_generation_check CHECK (((closed_generation IS NULL) OR (closed_generation >= 0))),
    CONSTRAINT definition_catalogue_activation_expected_head_check CHECK ((expected_head >= 0)),
    CONSTRAINT definition_catalogue_activation_native_position_check CHECK ((native_position >= 0)),
    CONSTRAINT definition_catalogue_activation_route_check CHECK ((route = 0)),
    CONSTRAINT definition_catalogue_activation_staged_sequence_check CHECK ((staged_sequence >= 0)),
    CONSTRAINT definition_catalogue_activation_state_check CHECK ((state = ANY (ARRAY['ready'::text, 'closing'::text, 'invalidating'::text, 'active'::text])))
);


--
-- Name: definition_catalogue_artifact; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_artifact (
    route integer NOT NULL,
    digest text NOT NULL,
    kind text NOT NULL,
    bytes bytea NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT definition_catalogue_artifact_bytes_check CHECK ((octet_length(bytes) <= 4194304)),
    CONSTRAINT definition_catalogue_artifact_kind_check CHECK ((kind = ANY (ARRAY['root'::text, 'node'::text, 'release'::text, 'declaration'::text]))),
    CONSTRAINT definition_catalogue_artifact_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_build; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_build (
    route integer NOT NULL,
    root_digest text NOT NULL,
    pin jsonb NOT NULL,
    state text NOT NULL,
    phase text DEFAULT 'node'::text NOT NULL,
    next_node bigint,
    steps bigint DEFAULT 0 NOT NULL,
    nodes bigint DEFAULT 0 NOT NULL,
    releases bigint DEFAULT 0 NOT NULL,
    declarations bigint DEFAULT 0 NOT NULL,
    indexed_rows bigint DEFAULT 0 NOT NULL,
    examined_bytes bigint DEFAULT 0 NOT NULL,
    missing_digest text,
    error text,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT definition_catalogue_build_phase_check CHECK ((phase = ANY (ARRAY['node'::text, 'release'::text, 'declaration'::text]))),
    CONSTRAINT definition_catalogue_build_route_check CHECK ((route = 0)),
    CONSTRAINT definition_catalogue_build_state_check CHECK ((state = ANY (ARRAY['building'::text, 'incomplete'::text, 'refused'::text, 'ready'::text])))
);


--
-- Name: definition_catalogue_checkpoint; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_checkpoint (
    route integer NOT NULL,
    root_digest text NOT NULL,
    phase text NOT NULL,
    job_id uuid NOT NULL,
    "position" bigint NOT NULL,
    result bytea NOT NULL,
    recorded_transaction_id uuid CONSTRAINT definition_catalogue_checkpoin_recorded_transaction_id_not_null NOT NULL,
    CONSTRAINT definition_catalogue_checkpoint_phase_check CHECK ((phase = ANY (ARRAY['step'::text, 'activation-step'::text]))),
    CONSTRAINT definition_catalogue_checkpoint_position_check CHECK (("position" >= 0)),
    CONSTRAINT definition_catalogue_checkpoint_result_check CHECK (((octet_length(result) >= 1) AND (octet_length(result) <= 65536))),
    CONSTRAINT definition_catalogue_checkpoint_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_consumer; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_consumer (
    route integer NOT NULL,
    root_digest text NOT NULL,
    id text NOT NULL,
    sequence bigint NOT NULL,
    enrollment_generation bigint NOT NULL,
    consumer bytea NOT NULL,
    provenance bytea NOT NULL,
    dependency bytea NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    invalidated_generation bigint,
    invalidation_receipt bytea,
    owner_generation text,
    restore_generation text,
    CONSTRAINT definition_catalogue_consumer_check CHECK ((((state = 'invalidated'::text) AND (invalidated_generation IS NOT NULL) AND (invalidation_receipt IS NOT NULL) AND (owner_generation IS NOT NULL) AND (restore_generation IS NOT NULL)) OR ((state <> 'invalidated'::text) AND (invalidated_generation IS NULL) AND (invalidation_receipt IS NULL)))),
    CONSTRAINT definition_catalogue_consumer_consumer_check CHECK ((octet_length(consumer) <= 8192)),
    CONSTRAINT definition_catalogue_consumer_dependency_check CHECK (((octet_length(dependency) >= 1) AND (octet_length(dependency) <= 65536))),
    CONSTRAINT definition_catalogue_consumer_enrollment_generation_check CHECK ((enrollment_generation > 0)),
    CONSTRAINT definition_catalogue_consumer_invalidation_receipt_check CHECK (((octet_length(invalidation_receipt) >= 1) AND (octet_length(invalidation_receipt) <= 8192))),
    CONSTRAINT definition_catalogue_consumer_provenance_check CHECK (((octet_length(provenance) >= 1) AND (octet_length(provenance) <= 8192))),
    CONSTRAINT definition_catalogue_consumer_route_check CHECK ((route = 0)),
    CONSTRAINT definition_catalogue_consumer_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT definition_catalogue_consumer_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'bound'::text, 'negative'::text, 'in_flight'::text, 'uncertain'::text, 'invalidated'::text])))
);


--
-- Name: definition_catalogue_enrollment; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_enrollment (
    route integer NOT NULL,
    root_digest text NOT NULL,
    protocol integer NOT NULL,
    state text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    last_sequence bigint DEFAULT 0 NOT NULL,
    closed_generation bigint,
    closed_sequence bigint,
    recorded_transaction_id uuid CONSTRAINT definition_catalogue_enrollmen_recorded_transaction_id_not_null NOT NULL,
    CONSTRAINT definition_catalogue_enrollment_check CHECK ((((protocol = 0) AND (state = 'unproven'::text)) OR ((protocol = 1) AND (state = ANY (ARRAY['open'::text, 'closed'::text]))))),
    CONSTRAINT definition_catalogue_enrollment_check1 CHECK ((((state = 'closed'::text) AND (closed_generation IS NOT NULL) AND (closed_sequence IS NOT NULL) AND (closed_generation = generation) AND (closed_sequence = last_sequence)) OR ((state <> 'closed'::text) AND (closed_generation IS NULL) AND (closed_sequence IS NULL)))),
    CONSTRAINT definition_catalogue_enrollment_generation_check CHECK ((generation > 0)),
    CONSTRAINT definition_catalogue_enrollment_last_sequence_check CHECK ((last_sequence >= 0)),
    CONSTRAINT definition_catalogue_enrollment_protocol_check CHECK ((protocol = ANY (ARRAY[0, 1]))),
    CONSTRAINT definition_catalogue_enrollment_route_check CHECK ((route = 0)),
    CONSTRAINT definition_catalogue_enrollment_state_check CHECK ((state = ANY (ARRAY['unproven'::text, 'open'::text, 'closed'::text])))
);


--
-- Name: definition_catalogue_frontier; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_frontier (
    route integer NOT NULL,
    root_digest text NOT NULL,
    slot integer NOT NULL,
    consumer_id text NOT NULL,
    sequence bigint NOT NULL,
    closed_generation bigint NOT NULL,
    consumer bytea NOT NULL,
    provenance bytea NOT NULL,
    dependency bytea NOT NULL,
    enrollment_generation bigint NOT NULL,
    consumer_state text NOT NULL,
    consumer_root text NOT NULL,
    CONSTRAINT definition_catalogue_frontier_consumer_check CHECK ((octet_length(consumer) <= 8192)),
    CONSTRAINT definition_catalogue_frontier_consumer_state_check CHECK ((consumer_state = ANY (ARRAY['pending'::text, 'bound'::text, 'negative'::text, 'in_flight'::text, 'uncertain'::text]))),
    CONSTRAINT definition_catalogue_frontier_dependency_check CHECK (((octet_length(dependency) >= 1) AND (octet_length(dependency) <= 65536))),
    CONSTRAINT definition_catalogue_frontier_enrollment_generation_check CHECK ((enrollment_generation > 0)),
    CONSTRAINT definition_catalogue_frontier_provenance_check CHECK (((octet_length(provenance) >= 1) AND (octet_length(provenance) <= 8192))),
    CONSTRAINT definition_catalogue_frontier_route_check CHECK ((route = 0)),
    CONSTRAINT definition_catalogue_frontier_slot_check CHECK (((slot >= 1) AND (slot <= 100)))
);


--
-- Name: definition_catalogue_head; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_head (
    route integer NOT NULL,
    root_digest text,
    head integer DEFAULT 0 NOT NULL,
    recorded_transaction_id uuid,
    CONSTRAINT definition_catalogue_head_head_check CHECK ((head >= 0)),
    CONSTRAINT definition_catalogue_head_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_identity; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_identity (
    route integer NOT NULL,
    root_digest text NOT NULL,
    identity_key text NOT NULL,
    identity bytea NOT NULL,
    digest text NOT NULL,
    CONSTRAINT definition_catalogue_identity_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_kind; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_kind (
    route integer NOT NULL,
    root_digest text NOT NULL,
    id_key text NOT NULL,
    id bytea NOT NULL,
    ordinal bigint NOT NULL,
    declaration_digest text NOT NULL,
    body json NOT NULL,
    exact_type_key text NOT NULL,
    exact_type_id bytea NOT NULL,
    precedence integer NOT NULL,
    eligible boolean NOT NULL,
    CONSTRAINT definition_catalogue_kind_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_label; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_label (
    route integer NOT NULL,
    root_digest text NOT NULL,
    language_key text NOT NULL,
    language text NOT NULL,
    label_sort bytea NOT NULL,
    ordinal bigint NOT NULL,
    id_key text NOT NULL,
    CONSTRAINT definition_catalogue_label_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_member; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_member (
    route integer NOT NULL,
    root_digest text NOT NULL,
    release_digest text NOT NULL,
    category text NOT NULL,
    id_key text NOT NULL,
    id bytea NOT NULL,
    body json NOT NULL,
    CONSTRAINT definition_catalogue_member_category_check CHECK ((category = ANY (ARRAY['type'::text, 'property'::text, 'profile'::text]))),
    CONSTRAINT definition_catalogue_member_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_original; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_original (
    route integer NOT NULL,
    original_key text NOT NULL,
    owner text NOT NULL,
    root_digest text NOT NULL,
    phase text NOT NULL,
    origin text NOT NULL,
    input_digest bytea NOT NULL,
    episode uuid NOT NULL,
    deadline_ms bigint NOT NULL,
    admitted bigint[] NOT NULL,
    spent bigint[] DEFAULT ARRAY[(0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint] NOT NULL,
    "position" bigint NOT NULL,
    state text DEFAULT 'admitted'::text NOT NULL,
    dispatch_transaction_id uuid,
    terminal_transaction_id uuid,
    result_digest bytea,
    CONSTRAINT definition_catalogue_original_check CHECK (semantic.catalogue_work_valid(admitted, spent)),
    CONSTRAINT definition_catalogue_original_check1 CHECK (((state = 'admitted'::text) OR (spent = admitted))),
    CONSTRAINT definition_catalogue_original_check2 CHECK (((state = 'admitted'::text) = (dispatch_transaction_id IS NULL))),
    CONSTRAINT definition_catalogue_original_check3 CHECK (((state = 'terminal'::text) = (terminal_transaction_id IS NOT NULL))),
    CONSTRAINT definition_catalogue_original_check4 CHECK (((state = 'terminal'::text) = (result_digest IS NOT NULL))),
    CONSTRAINT definition_catalogue_original_deadline_ms_check CHECK (((deadline_ms > 0) AND (deadline_ms <= '9007199254740991'::bigint))),
    CONSTRAINT definition_catalogue_original_input_digest_check CHECK ((octet_length(input_digest) = 32)),
    CONSTRAINT definition_catalogue_original_origin_check CHECK ((origin = ANY (ARRAY['command'::text, 'build'::text, 'activation'::text]))),
    CONSTRAINT definition_catalogue_original_original_key_check CHECK ((original_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT definition_catalogue_original_owner_check CHECK ((owner = 'semantic.catalogue'::text)),
    CONSTRAINT definition_catalogue_original_phase_check CHECK ((phase = ANY (ARRAY['artifact'::text, 'build'::text, 'step'::text, 'activate'::text, 'activation-step'::text]))),
    CONSTRAINT definition_catalogue_original_position_check CHECK (("position" >= 0)),
    CONSTRAINT definition_catalogue_original_result_digest_check CHECK ((octet_length(result_digest) = 32)),
    CONSTRAINT definition_catalogue_original_root_digest_check CHECK ((root_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT definition_catalogue_original_route_check CHECK ((route = 0)),
    CONSTRAINT definition_catalogue_original_state_check CHECK ((state = ANY (ARRAY['admitted'::text, 'spent'::text, 'terminal'::text])))
);


--
-- Name: definition_catalogue_position; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_position (
    route integer NOT NULL,
    root_digest text NOT NULL,
    phase text NOT NULL,
    native_position bigint NOT NULL,
    original_key text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT definition_catalogue_position_native_position_check CHECK ((native_position >= 0)),
    CONSTRAINT definition_catalogue_position_phase_check CHECK ((phase = ANY (ARRAY['build'::text, 'activation'::text]))),
    CONSTRAINT definition_catalogue_position_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_retirement; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_retirement (
    route integer NOT NULL,
    root_digest text NOT NULL,
    phase text DEFAULT 'captures'::text NOT NULL,
    after_sequence bigint DEFAULT 0 NOT NULL,
    after_original text DEFAULT ''::text NOT NULL,
    recorded_transaction_id uuid CONSTRAINT definition_catalogue_retiremen_recorded_transaction_id_not_null NOT NULL,
    CONSTRAINT definition_catalogue_retirement_after_original_check CHECK ((octet_length(after_original) <= 64)),
    CONSTRAINT definition_catalogue_retirement_after_sequence_check CHECK ((after_sequence >= 0)),
    CONSTRAINT definition_catalogue_retirement_phase_check CHECK ((phase = ANY (ARRAY['captures'::text, 'consumers'::text, 'tickets'::text, 'positions'::text, 'terminal'::text]))),
    CONSTRAINT definition_catalogue_retirement_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_task; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_task (
    route integer NOT NULL,
    root_digest text NOT NULL,
    task_id bigint NOT NULL,
    kind text NOT NULL,
    digest text NOT NULL,
    entry_key bytea,
    first_key bytea,
    last_key bytea,
    next_node bigint,
    offset_rows integer DEFAULT 0 NOT NULL,
    done boolean DEFAULT false NOT NULL,
    CONSTRAINT definition_catalogue_task_kind_check CHECK ((kind = ANY (ARRAY['node'::text, 'release'::text, 'declaration'::text]))),
    CONSTRAINT definition_catalogue_task_route_check CHECK ((route = 0))
);


--
-- Name: definition_catalogue_task_task_id_seq; Type: SEQUENCE; Schema: semantic; Owner: -
--

ALTER TABLE semantic.definition_catalogue_task ALTER COLUMN task_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME semantic.definition_catalogue_task_task_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: definition_catalogue_ticket; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_catalogue_ticket (
    route integer NOT NULL,
    original_key text NOT NULL,
    slot integer NOT NULL,
    kind text NOT NULL,
    allowance bigint[] NOT NULL,
    state text DEFAULT 'admitted'::text NOT NULL,
    dispatch_transaction_id uuid,
    CONSTRAINT definition_catalogue_ticket_allowance_check CHECK (semantic.catalogue_work_valid(allowance, ARRAY[(0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint, (0)::bigint])),
    CONSTRAINT definition_catalogue_ticket_check CHECK (((state = 'spent'::text) = (dispatch_transaction_id IS NOT NULL))),
    CONSTRAINT definition_catalogue_ticket_kind_check CHECK ((kind = ANY (ARRAY['bootstrap'::text, 'authorization'::text, 'framework'::text, 'body'::text, 'observations'::text, 'lifecycle'::text, 'cleanup'::text]))),
    CONSTRAINT definition_catalogue_ticket_route_check CHECK ((route = 0)),
    CONSTRAINT definition_catalogue_ticket_slot_check CHECK (((slot >= 1) AND (slot <= 7))),
    CONSTRAINT definition_catalogue_ticket_state_check CHECK ((state = ANY (ARRAY['admitted'::text, 'spent'::text])))
);


--
-- Name: definition_release; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_release (
    route integer NOT NULL,
    digest text NOT NULL,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT definition_release_digest_check CHECK ((digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT definition_release_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: definition_type_build; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_type_build (
    route integer NOT NULL,
    catalogue text NOT NULL,
    after_release text DEFAULT ''::text NOT NULL,
    after_key text DEFAULT ''::text NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT definition_type_build_route_check CHECK ((route = 0))
);


--
-- Name: definition_type_edge; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_type_edge (
    route integer NOT NULL,
    catalogue text NOT NULL,
    locale text NOT NULL,
    parent_key text NOT NULL,
    chunk bytea NOT NULL,
    node_key text NOT NULL,
    entry_key text,
    CONSTRAINT definition_type_edge_chunk_check CHECK (((octet_length(chunk) >= 1) AND (octet_length(chunk) <= 128))),
    CONSTRAINT definition_type_edge_route_check CHECK ((route = 0))
);


--
-- Name: definition_type_entry; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_type_entry (
    route integer NOT NULL,
    catalogue text NOT NULL,
    id_key text NOT NULL,
    id json NOT NULL,
    release_digest text NOT NULL,
    body json NOT NULL,
    CONSTRAINT definition_type_entry_route_check CHECK ((route = 0))
);


--
-- Name: definition_type_property; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_type_property (
    route integer NOT NULL,
    release_digest text NOT NULL,
    id_key text NOT NULL,
    id json NOT NULL,
    body json NOT NULL,
    CONSTRAINT definition_type_property_route_check CHECK ((route = 0))
);


--
-- Name: erasure_copy_role; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_copy_role (
    partition_no integer NOT NULL,
    store text NOT NULL,
    record_key bigint NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL
);


--
-- Name: erasure_delivery; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_delivery (
    partition_no integer NOT NULL,
    source_position bigint NOT NULL,
    after_store text DEFAULT ''::text NOT NULL,
    after_key bigint DEFAULT 0 NOT NULL,
    after_account uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    after_role text DEFAULT ''::text NOT NULL,
    complete boolean DEFAULT false NOT NULL
);


--
-- Name: erasure_fence; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_fence (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    at timestamp with time zone
);


--
-- Name: erasure_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_home (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    at timestamp with time zone NOT NULL,
    state text DEFAULT 'local'::text NOT NULL,
    applied boolean DEFAULT false NOT NULL,
    CONSTRAINT erasure_home_state_check CHECK ((state = ANY (ARRAY['local'::text, 'complete'::text])))
);


--
-- Name: erasure_inbox; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_inbox (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    source_partition integer NOT NULL,
    store text NOT NULL,
    record_key bigint NOT NULL,
    role text NOT NULL,
    delivery_position bigint NOT NULL,
    late boolean NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT erasure_inbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'minimized'::text, 'resolved'::text])))
);


--
-- Name: erasure_locator; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_locator (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL,
    store text NOT NULL,
    record_key bigint NOT NULL,
    source_transaction_id uuid,
    source_position bigint,
    delivery_position bigint NOT NULL,
    projection_global boolean DEFAULT false NOT NULL,
    priority smallint GENERATED ALWAYS AS (
CASE
    WHEN projection_global THEN 1
    ELSE
    CASE store
        WHEN 'inbound_link'::text THEN 0
        WHEN 'outbound_link'::text THEN 0
        WHEN 'source_candidate'::text THEN 0
        WHEN 'external_claim'::text THEN 0
        WHEN 'acceptance'::text THEN 0
        WHEN 'acceptance_current'::text THEN '-1'::integer
        WHEN 'retraction'::text THEN 0
        WHEN 'statement_disclosure'::text THEN 0
        WHEN 'release_composite'::text THEN 0
        WHEN 'context_extension_activation'::text THEN 0
        WHEN 'context_extension'::text THEN 1
        WHEN 'fact'::text THEN 2
        WHEN 'candidate'::text THEN 3
        WHEN 'account_agent_subject'::text THEN 7
        WHEN 'revision'::text THEN 8
        WHEN 'write_basis'::text THEN 9
        ELSE 4
    END
END) STORED,
    state text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT erasure_locator_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT erasure_locator_role_check CHECK ((role = ANY (ARRAY['actor'::text, 'author'::text, 'editor'::text, 'acting-human'::text, 'delegate'::text, 'owner'::text, 'subject'::text, 'operator'::text]))),
    CONSTRAINT erasure_locator_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'minimized'::text])))
);


--
-- Name: erasure_progress; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    at timestamp with time zone NOT NULL,
    partition_no integer DEFAULT 0 NOT NULL,
    state text DEFAULT 'local'::text NOT NULL,
    applied boolean DEFAULT false NOT NULL,
    workflow_id text,
    source_protocol integer DEFAULT 0 NOT NULL,
    source_version integer,
    CONSTRAINT erasure_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4096))),
    CONSTRAINT erasure_progress_state_check CHECK ((state = ANY (ARRAY['local'::text, 'pending-shared-custody'::text])))
);


--
-- Name: erasure_provenance; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_provenance (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    record_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    minimized boolean DEFAULT false NOT NULL
);


--
-- Name: erasure_shared_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_shared_custody (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL,
    transaction_id uuid NOT NULL,
    outbox_position bigint,
    state text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT erasure_shared_custody_state_check CHECK ((state = 'pending'::text))
);


--
-- Name: erasure_source_commit; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_commit (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL
);


--
-- Name: erasure_source_disposition; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_disposition (
    partition_no integer NOT NULL,
    store text NOT NULL,
    record_key bigint NOT NULL,
    disposition text NOT NULL,
    transaction_id uuid NOT NULL,
    native_xmin text,
    CONSTRAINT erasure_source_disposition_disposition_check CHECK ((disposition = ANY (ARRAY['removed'::text, 'retained-nonpersonal'::text])))
);


--
-- Name: erasure_source_hold; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_hold (
    partition_no integer NOT NULL,
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    store text NOT NULL,
    record_key bigint NOT NULL,
    role text NOT NULL,
    delivery_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    original uuid,
    previous_terminal uuid,
    current_terminal uuid,
    source_home integer,
    source_revision integer,
    source_security_revision bigint,
    source_release text,
    slot_id uuid,
    candidate_id uuid,
    property text,
    tuple_route integer,
    source_name text,
    external_id text,
    field_group text,
    disposition text,
    origin_key text,
    CONSTRAINT erasure_source_hold_disposition_check CHECK ((disposition = ANY (ARRAY['remove'::text, 'replace'::text, 'retain_deidentified'::text])))
);


--
-- Name: erasure_source_page; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_page (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    id uuid NOT NULL,
    previous_id uuid,
    source_partition integer,
    store text,
    record_key bigint,
    role text,
    delivery_position bigint,
    source_epoch integer,
    source_position bigint,
    source_transaction_id uuid,
    role_epoch integer,
    role_position bigint,
    role_transaction_id uuid,
    transfer_transaction_id uuid,
    original uuid,
    previous_terminal uuid,
    current_terminal uuid,
    source_home integer,
    source_revision integer,
    source_security_revision bigint,
    source_release text,
    slot_id uuid,
    candidate_id uuid,
    property text,
    tuple_route integer,
    source_name text,
    external_id text,
    field_group text,
    disposition text,
    complete boolean NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    origin_key text,
    CONSTRAINT erasure_source_page_disposition_check CHECK ((disposition = ANY (ARRAY['remove'::text, 'replace'::text, 'retain_deidentified'::text])))
);


--
-- Name: erasure_source_record; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_record (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL,
    store text NOT NULL,
    record_key bigint NOT NULL,
    delivery_position bigint NOT NULL,
    source_transaction_id uuid,
    source_position bigint,
    native_present boolean NOT NULL,
    original uuid,
    previous_terminal uuid,
    identity_epoch bigint,
    slot_id uuid,
    candidate_id uuid,
    property text,
    release text,
    context_id uuid,
    source_name text,
    external_id text,
    field_group text,
    origin_key text GENERATED ALWAYS AS (((COALESCE((source_transaction_id)::text, ''::text) || '/'::text) || COALESCE((source_position)::text, ''::text))) STORED NOT NULL
);


--
-- Name: erasure_source_role; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_role (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL
);


--
-- Name: erasure_source_seal; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_seal (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL
);


--
-- Name: erasure_source_terminal; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.erasure_source_terminal (
    route integer CONSTRAINT erasure_source_page_route_not_null NOT NULL,
    account_id uuid CONSTRAINT erasure_source_page_account_id_not_null NOT NULL,
    version integer CONSTRAINT erasure_source_page_version_not_null NOT NULL,
    at timestamp with time zone CONSTRAINT erasure_source_page_at_not_null NOT NULL,
    id uuid CONSTRAINT erasure_source_page_id_not_null NOT NULL,
    previous_id uuid,
    source_partition integer,
    store text,
    record_key bigint,
    role text,
    delivery_position bigint,
    source_epoch integer,
    source_position bigint,
    source_transaction_id uuid,
    role_epoch integer,
    role_position bigint,
    role_transaction_id uuid,
    transfer_transaction_id uuid,
    original uuid,
    previous_terminal uuid,
    current_terminal uuid,
    source_home integer,
    source_revision integer,
    source_security_revision bigint,
    source_release text,
    slot_id uuid,
    candidate_id uuid,
    property text,
    tuple_route integer,
    source_name text,
    external_id text,
    field_group text,
    disposition text,
    complete boolean CONSTRAINT erasure_source_page_complete_not_null NOT NULL,
    consumed boolean DEFAULT false CONSTRAINT erasure_source_page_consumed_not_null NOT NULL,
    origin_key text,
    CONSTRAINT erasure_source_page_disposition_check CHECK ((disposition = ANY (ARRAY['remove'::text, 'replace'::text, 'retain_deidentified'::text])))
);


--
-- Name: external_claim; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.external_claim (
    route integer NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    subject_id uuid NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT external_claim_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: facet_population_frontier; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.facet_population_frontier (
    partition_no integer NOT NULL,
    frontier uuid NOT NULL,
    predecessor uuid,
    observation text NOT NULL,
    binding text NOT NULL,
    capture text NOT NULL,
    state jsonb NOT NULL,
    subjects jsonb NOT NULL,
    complete boolean NOT NULL,
    expires bigint NOT NULL,
    CONSTRAINT facet_population_frontier_subjects_check CHECK (((jsonb_typeof(subjects) = 'array'::text) AND (jsonb_array_length(subjects) <= 256)))
);


--
-- Name: hidden_candidate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.hidden_candidate (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    visibility text NOT NULL,
    security_revision bigint NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT hidden_candidate_candidate_route_check CHECK ((route = ((get_byte(uuid_send(candidate_id), 10) * 256) + get_byte(uuid_send(candidate_id), 11)))),
    CONSTRAINT hidden_candidate_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT hidden_candidate_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT hidden_candidate_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT hidden_candidate_visibility_check CHECK ((visibility = ANY (ARRAY['hidden'::text, 'taken_down'::text])))
);


--
-- Name: identity_epoch_ack; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_ack (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    step text NOT NULL,
    version integer NOT NULL,
    scope_digest text NOT NULL,
    progress jsonb NOT NULL,
    native_partition integer NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    native_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_ack_step_check CHECK ((step = ANY (ARRAY['mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text]))),
    CONSTRAINT identity_epoch_ack_version_check CHECK ((version = 1))
);


--
-- Name: identity_epoch_admission_attempt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_attempt (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    state text NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_admission_attempt_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'acquired'::text, 'closed'::text])))
);


--
-- Name: identity_epoch_admission_handoff; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_handoff (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    job_home integer NOT NULL,
    source_transaction_id uuid NOT NULL,
    inputs jsonb NOT NULL
);


--
-- Name: identity_epoch_admission_plan; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_plan (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    resource_home integer NOT NULL,
    acquired_transaction_id uuid,
    acquired_epoch integer,
    acquired_position bigint,
    closed_transaction_id uuid,
    closed_epoch integer,
    closed_position bigint,
    waiting boolean DEFAULT true NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    prepared_transaction_id uuid,
    prepared_epoch integer,
    prepared_position bigint,
    released boolean DEFAULT false NOT NULL
);


--
-- Name: identity_epoch_admission_receipt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_receipt (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    stage text NOT NULL,
    version integer NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_admission_receipt_stage_check CHECK ((stage = ANY (ARRAY['prepared'::text, 'acquired'::text, 'closed'::text]))),
    CONSTRAINT identity_epoch_admission_receipt_version_check CHECK ((version = 1))
);


--
-- Name: identity_epoch_admission_source; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_source (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    original uuid NOT NULL,
    route integer NOT NULL,
    control_partition integer NOT NULL,
    terminal uuid NOT NULL,
    generation uuid NOT NULL,
    basis_version bigint NOT NULL,
    source_revision bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    owner_epoch integer NOT NULL,
    source_owner_epoch integer NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_admission_source_hold; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_source_hold (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    original uuid NOT NULL,
    route integer NOT NULL,
    scope_digest text NOT NULL,
    basis jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    closed boolean DEFAULT false NOT NULL
);


--
-- Name: identity_epoch_admission_validation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_validation (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    original uuid NOT NULL,
    source_home integer NOT NULL,
    transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL
);


--
-- Name: identity_epoch_bootstrap_basis; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_basis (
    partition_no integer NOT NULL,
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL
);


--
-- Name: identity_epoch_bootstrap_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_custody (
    partition_no integer DEFAULT 0 NOT NULL,
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL,
    native_transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    stage text DEFAULT 'add'::text NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_custody_stage_check CHECK ((stage = ANY (ARRAY['withdraw'::text, 'add'::text])))
);


--
-- Name: identity_epoch_bootstrap_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_home (
    partition_no integer NOT NULL,
    phase text NOT NULL,
    after_route integer NOT NULL,
    after_original uuid NOT NULL,
    after_member uuid NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    owner_epoch integer,
    needs_work boolean DEFAULT true NOT NULL,
    sealed_generation bigint,
    sealed_transaction_id uuid,
    sealed_epoch integer,
    sealed_position bigint,
    closure_after_route integer DEFAULT '-1'::integer NOT NULL,
    closure_after_original uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    closure_ticket_after_route integer DEFAULT '-1'::integer CONSTRAINT identity_epoch_bootstrap_ho_closure_ticket_after_route_not_null NOT NULL,
    closure_ticket_after_original uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid CONSTRAINT identity_epoch_bootstrap_ho_closure_ticket_after_origi_not_null NOT NULL,
    closure_cancel_after_route integer DEFAULT '-1'::integer CONSTRAINT identity_epoch_bootstrap_ho_closure_cancel_after_route_not_null NOT NULL,
    closure_cancel_after_original uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid CONSTRAINT identity_epoch_bootstrap_ho_closure_cancel_after_origi_not_null NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_home_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_bootstrap_home_phase_check CHECK ((phase = ANY (ARRAY['subjects'::text, 'members'::text, 'dirty'::text, 'member-dirty'::text])))
);


--
-- Name: identity_epoch_bootstrap_page; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_page (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    generation bigint NOT NULL,
    phase text NOT NULL,
    caught_up boolean DEFAULT false NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    closure_page_reservation uuid,
    CONSTRAINT identity_epoch_bootstrap_page_phase_check CHECK ((phase = ANY (ARRAY['subjects'::text, 'members'::text, 'dirty'::text, 'member-dirty'::text])))
);


--
-- Name: identity_epoch_bootstrap_row; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_row (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    route integer NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    source_revision bigint NOT NULL,
    present boolean NOT NULL,
    previous_partition integer,
    previous_terminal uuid,
    closure_enrollment uuid DEFAULT gen_random_uuid() NOT NULL,
    closure_complete boolean DEFAULT false NOT NULL
);


--
-- Name: identity_epoch_bootstrap_topology; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_topology (
    partition_no integer NOT NULL,
    next_partition integer DEFAULT 0 NOT NULL,
    remaining integer DEFAULT 4096 NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_topology_next_partition_check CHECK (((next_partition >= 0) AND (next_partition <= 4095))),
    CONSTRAINT identity_epoch_bootstrap_topology_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT identity_epoch_bootstrap_topology_remaining_check CHECK (((remaining >= 0) AND (remaining <= 4096)))
);


--
-- Name: identity_epoch_bootstrap_topology_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_topology_home (
    source_partition integer CONSTRAINT identity_epoch_bootstrap_topology_hom_source_partition_not_null NOT NULL,
    closed boolean DEFAULT false NOT NULL,
    partition_no integer NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_topology_home_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT identity_epoch_bootstrap_topology_home_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095)))
);


--
-- Name: identity_epoch_change; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_change (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    original uuid NOT NULL,
    previous_terminal uuid NOT NULL,
    terminal uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_control; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_control (
    partition_no integer NOT NULL,
    published_epoch bigint NOT NULL,
    pending_job uuid,
    pending_epoch bigint,
    allocated_epoch bigint DEFAULT 1 NOT NULL,
    prepare_job uuid,
    prepare_epoch bigint,
    CONSTRAINT identity_epoch_control_check CHECK (((pending_job IS NULL) = (pending_epoch IS NULL))),
    CONSTRAINT identity_epoch_control_published_epoch_check CHECK ((published_epoch >= 0))
);


--
-- Name: identity_epoch_dirty; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_dirty (
    route integer NOT NULL,
    original uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    captured_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT identity_epoch_dirty_check CHECK (((revision >= captured_revision) AND (captured_revision >= 0)))
);


--
-- Name: identity_epoch_effect_receipt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_effect_receipt (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    step text NOT NULL,
    effect_key text NOT NULL,
    kind text NOT NULL,
    native_partition integer,
    native_epoch integer,
    native_position bigint,
    native_transaction_id uuid,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_effect_receipt_check CHECK (((native_transaction_id IS NULL) = (native_partition IS NULL))),
    CONSTRAINT identity_epoch_effect_receipt_check1 CHECK (((native_transaction_id IS NULL) = (native_epoch IS NULL))),
    CONSTRAINT identity_epoch_effect_receipt_check2 CHECK (((native_transaction_id IS NULL) = (native_position IS NULL))),
    CONSTRAINT identity_epoch_effect_receipt_kind_check CHECK ((kind = ANY (ARRAY['remove'::text, 'add'::text, 'pending-fence'::text, 'published-fence'::text]))),
    CONSTRAINT identity_epoch_effect_receipt_step_check CHECK ((step = ANY (ARRAY['mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text])))
);


--
-- Name: identity_epoch_group; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_group (
    partition_no integer DEFAULT 0 NOT NULL,
    terminal uuid NOT NULL,
    observed_count bigint NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_epoch integer,
    version bigint DEFAULT 1 NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    published_epoch bigint DEFAULT 1 NOT NULL,
    pending_job uuid,
    pending_epoch bigint,
    closure_incarnation uuid DEFAULT gen_random_uuid() NOT NULL,
    closure_state text DEFAULT 'open'::text NOT NULL,
    closure_claim uuid,
    closure_after uuid,
    closure_close_transaction uuid,
    closure_seal_transaction uuid,
    closure_cleanup_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_epoch_group_closure_state_check CHECK ((closure_state = ANY (ARRAY['open'::text, 'closing'::text, 'drained'::text]))),
    CONSTRAINT identity_epoch_group_observed_count_check CHECK ((observed_count >= 0))
);


--
-- Name: identity_epoch_home_gate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_home_gate (
    route integer NOT NULL,
    destination uuid NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    epoch bigint NOT NULL,
    pending_job uuid,
    pending_epoch bigint,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_home_gate_check CHECK ((route = ((get_byte(uuid_send(destination), 10) * 256) + get_byte(uuid_send(destination), 11)))),
    CONSTRAINT identity_epoch_home_gate_check1 CHECK (((pending_job IS NULL) = (pending_epoch IS NULL))),
    CONSTRAINT identity_epoch_home_gate_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT identity_epoch_home_gate_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: identity_epoch_input; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_input (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    terminal uuid NOT NULL,
    generation uuid NOT NULL,
    basis_version bigint NOT NULL,
    original_count bigint NOT NULL,
    control_partition integer NOT NULL,
    owner_epoch integer,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    prearm_sequence bigint DEFAULT 0 NOT NULL,
    prearm_transaction_id uuid,
    prearm_epoch integer,
    prearm_position bigint,
    prearm_cancelled_transaction_id uuid
);


--
-- Name: identity_epoch_installation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_installation (
    partition_no integer NOT NULL,
    mode text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_epoch_installation_mode_check CHECK ((mode = ANY (ARRAY['absence'::text, 'legacy'::text]))),
    CONSTRAINT identity_epoch_installation_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: identity_epoch_installation_cut; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_installation_cut (
    partition_no integer NOT NULL,
    mode text NOT NULL,
    installation_xid text NOT NULL,
    CONSTRAINT identity_epoch_installation_cut_mode_check CHECK ((mode = ANY (ARRAY['absence'::text, 'legacy'::text]))),
    CONSTRAINT identity_epoch_installation_cut_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: identity_epoch_job; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_job (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    epoch bigint NOT NULL,
    intent jsonb NOT NULL,
    receipt_key text NOT NULL,
    receipt jsonb NOT NULL,
    scope_digest text NOT NULL,
    state text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    remainder_terminal uuid,
    prearm_phase text DEFAULT 'prearm-open'::text NOT NULL,
    prearm_transaction_id uuid,
    cancellation_transaction_id uuid,
    CONSTRAINT identity_epoch_job_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT identity_epoch_job_prearm_phase_check CHECK ((prearm_phase = ANY (ARRAY['prearm-open'::text, 'prearm-sealed'::text, 'claiming'::text]))),
    CONSTRAINT identity_epoch_job_remainder_check CHECK (((remainder_terminal IS NULL) OR (((intent ->> 'kind'::text) = ANY (ARRAY['repoint'::text, 'unmerge'::text])) AND ((remainder_terminal)::text <> (intent ->> 'original'::text))))),
    CONSTRAINT identity_epoch_job_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'pending'::text, 'cancelling'::text, 'cancelled'::text, 'published'::text])))
);


--
-- Name: identity_epoch_legacy_member; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_legacy_member (
    partition_no integer DEFAULT 0 NOT NULL,
    terminal uuid NOT NULL,
    original uuid NOT NULL,
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL
);


--
-- Name: identity_epoch_mapping; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping (
    route integer NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    epoch bigint NOT NULL,
    origin text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    control_partition integer,
    control_group uuid,
    source_revision bigint DEFAULT 0 NOT NULL,
    owner_epoch integer DEFAULT 1 NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    closure_state text DEFAULT 'legacy'::text NOT NULL,
    closure_enrollment uuid,
    closure_generation uuid,
    closure_incarnation uuid,
    closure_immediate uuid,
    closure_export_transaction uuid,
    closure_hold_transaction uuid,
    closure_hold_xid text,
    closure_registration_transaction uuid,
    closure_install_transaction uuid,
    closure_install_xid text,
    closure_ack_transaction uuid,
    closure_ack_xid text,
    closure_source_reservation uuid,
    closure_claim uuid,
    closure_withdraw_transaction uuid,
    closure_withdraw_xid text,
    closure_successor_ticket uuid,
    closure_successor_original uuid,
    closure_ticket_reservation uuid,
    closure_mutation_xid text,
    closure_cancelled_successor boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_epoch_mapping_check CHECK ((route = ((get_byte(uuid_send(original), 10) * 256) + get_byte(uuid_send(original), 11)))),
    CONSTRAINT identity_epoch_mapping_closure_state_check CHECK ((closure_state = ANY (ARRAY['legacy'::text, 'exporting'::text, 'installed'::text, 'active'::text, 'withdrawn'::text]))),
    CONSTRAINT identity_epoch_mapping_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT identity_epoch_mapping_origin_check CHECK ((origin = ANY (ARRAY['creation'::text, 'published'::text]))),
    CONSTRAINT identity_epoch_mapping_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: identity_epoch_mapping_effect; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_effect (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    unit integer NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    plan_digest text NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_mapping_fence; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_fence (
    route integer NOT NULL,
    destination uuid NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_mapping_fence_check CHECK ((route = ((get_byte(uuid_send(destination), 10) * 256) + get_byte(uuid_send(destination), 11))))
);


--
-- Name: identity_epoch_mapping_generation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_generation (
    partition_no integer NOT NULL,
    slot integer NOT NULL,
    job_id uuid,
    generation uuid NOT NULL,
    terminal uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    closure_copies integer DEFAULT 0 NOT NULL,
    closure_source_pool boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_epoch_mapping_generation_closure_copies_check CHECK (((closure_copies >= 0) AND (closure_copies <= 4096))),
    CONSTRAINT identity_epoch_mapping_generation_slot_check CHECK (((slot >= 0) AND (slot <= 3)))
);


--
-- Name: identity_epoch_mapping_head; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_head (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    unit integer NOT NULL,
    frontier jsonb NOT NULL,
    change jsonb,
    payload jsonb,
    outputs jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_mapping_head_frontier_check CHECK (((jsonb_array_length((frontier -> 'after'::text)) <= 8) AND (octet_length((frontier)::text) <= 2048))),
    CONSTRAINT identity_epoch_mapping_head_outputs_check CHECK ((jsonb_array_length(outputs) <= 2)),
    CONSTRAINT identity_epoch_mapping_head_payload_check CHECK ((octet_length((payload)::text) <= 4096)),
    CONSTRAINT identity_epoch_mapping_head_unit_check CHECK ((unit >= 0))
);


--
-- Name: identity_epoch_mapping_payload; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_payload (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    unit integer NOT NULL,
    result jsonb NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_mapping_payload_result_check CHECK ((octet_length((result)::text) <= 4096))
);


--
-- Name: identity_epoch_mapping_plan; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_plan (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    unit integer NOT NULL,
    plan_digest text NOT NULL,
    home integer NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_mapping_undo; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_undo (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    original uuid NOT NULL,
    previous_terminal uuid NOT NULL,
    terminal uuid NOT NULL,
    unit integer NOT NULL,
    transaction_id uuid NOT NULL,
    fact_revision integer NOT NULL,
    security_revision bigint NOT NULL,
    release text NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    fact_projection_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_epoch_mapping_undo_check CHECK ((partition_no = (((get_byte(uuid_send(original), 10) * 256) + get_byte(uuid_send(original), 11)) / 16)))
);


--
-- Name: identity_epoch_mapping_withdrawal; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping_withdrawal (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    original uuid NOT NULL,
    property text NOT NULL,
    target uuid NOT NULL,
    statement uuid NOT NULL,
    filter uuid NOT NULL,
    context uuid NOT NULL,
    unit integer NOT NULL,
    transaction_id uuid NOT NULL,
    "row" jsonb NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_mapping_withdrawal_check CHECK ((partition_no = (((get_byte(uuid_send(original), 10) * 256) + get_byte(uuid_send(original), 11)) / 16))),
    CONSTRAINT identity_epoch_mapping_withdrawal_row_check CHECK ((octet_length(("row")::text) <= 4096))
);


--
-- Name: identity_epoch_member_dirty; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_member_dirty (
    route integer NOT NULL,
    terminal uuid NOT NULL,
    original uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    captured_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT identity_epoch_member_dirty_check CHECK (((revision >= captured_revision) AND (captured_revision >= 0)))
);


--
-- Name: identity_epoch_native_commit; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_native_commit (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    purpose text NOT NULL,
    CONSTRAINT identity_epoch_native_commit_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_native_commit_purpose_check CHECK (((purpose = ANY (ARRAY['bootstrap'::text, 'admission'::text, 'mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text, 'identity-receiving-plan'::text, 'identity-receiving-record'::text, 'identity-receiving-custody'::text, 'identity-prearm'::text, 'identity-prearm-cancel'::text, 'identity-scope-registration'::text, 'identity-scope-enrollment'::text, 'identity-scope-preparation'::text, 'identity-scope-cancellation'::text, 'identity-public-capture'::text, 'identity-scope-finish'::text, 'identity-scope-retirement'::text, 'identity-scope-directory-release'::text, 'identity-prearm-release'::text])) OR (purpose = 'identity-public-output-capture'::text) OR (purpose = ANY (ARRAY['identity-public-output-applied'::text, 'identity-public-output-cancelled'::text]))))
);


--
-- Name: identity_epoch_original; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_original (
    partition_no integer DEFAULT 0 NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL,
    present boolean NOT NULL,
    generation uuid NOT NULL,
    closure_state text DEFAULT 'legacy'::text NOT NULL,
    closure_enrollment uuid,
    closure_incarnation uuid,
    closure_source_revision bigint,
    closure_source_epoch integer,
    closure_export_transaction uuid,
    closure_registration_transaction uuid,
    closure_registration_xid text,
    closure_install_transaction uuid,
    closure_disposition_transaction uuid,
    closure_release_transaction uuid,
    closure_disposition_epoch integer,
    closure_disposition_position bigint,
    closure_claim uuid,
    closure_reservation uuid,
    CONSTRAINT identity_epoch_original_closure_state_check CHECK ((closure_state = ANY (ARRAY['legacy'::text, 'preparing'::text, 'installed'::text, 'withdrawn'::text])))
);


--
-- Name: identity_epoch_prearm_bridge; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_bridge (
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    terminal uuid NOT NULL,
    owner_epoch integer NOT NULL,
    basis_version bigint NOT NULL,
    bridge_version bigint DEFAULT 0 NOT NULL,
    job_id uuid,
    job_epoch bigint,
    scope_digest text,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_prearm_bridge_check CHECK (((job_id IS NULL) = (job_epoch IS NULL)))
);


--
-- Name: identity_epoch_prearm_claim; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_claim (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    seal jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_prearm_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_custody (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    generation uuid NOT NULL,
    sequence bigint NOT NULL,
    directory_partition integer NOT NULL,
    page_id uuid NOT NULL,
    directory_receipt jsonb NOT NULL,
    source_receipt jsonb,
    empty boolean NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_prearm_decision; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_decision (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    stage text NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_prearm_decision_stage_check CHECK ((stage = ANY (ARRAY['sealed'::text, 'cancelled'::text])))
);


--
-- Name: identity_epoch_prearm_directory; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_directory (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    generation uuid NOT NULL,
    terminal uuid NOT NULL,
    basis_version bigint NOT NULL,
    owner_epoch integer NOT NULL,
    scope_digest text NOT NULL,
    attempt_transaction_id uuid NOT NULL,
    sequence bigint DEFAULT 0 NOT NULL,
    after_original uuid,
    after_scope text,
    after_registration text,
    exhausted boolean DEFAULT false NOT NULL,
    sealed_transaction_id uuid,
    released boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    cancel_sequence bigint DEFAULT 0 NOT NULL,
    cancelled_transaction_id uuid,
    release_transaction_id uuid
);


--
-- Name: identity_epoch_prearm_disposition; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_disposition (
    partition_no integer NOT NULL,
    page_id uuid NOT NULL,
    stage text NOT NULL,
    transaction_id uuid NOT NULL,
    source_receipt jsonb,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_prearm_disposition_stage_check CHECK ((stage = ANY (ARRAY['unsafe'::text, 'cancelled'::text])))
);


--
-- Name: identity_epoch_prearm_inverse; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_inverse (
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    original uuid NOT NULL,
    scope_key text NOT NULL,
    registration text NOT NULL,
    scope jsonb NOT NULL,
    capture_id text NOT NULL,
    source_partition integer NOT NULL,
    source_owner_epoch integer NOT NULL,
    transaction_id uuid NOT NULL,
    retired boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_prearm_page; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_prearm_page (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    generation uuid NOT NULL,
    sequence bigint NOT NULL,
    page_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    original uuid,
    scope_key text,
    registration text,
    scope jsonb,
    capture_id text,
    source_partition integer,
    source_owner_epoch integer,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_prearm_page_check CHECK (((original IS NULL) = (scope IS NULL)))
);


--
-- Name: identity_epoch_receipt_binding; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receipt_binding (
    partition_no integer NOT NULL,
    receipt_key text NOT NULL,
    account_id uuid NOT NULL,
    intent_digest text NOT NULL,
    generation bigint NOT NULL,
    state text NOT NULL,
    accepted_job uuid,
    accepted_epoch bigint,
    consumer_undo_generation bigint,
    consumer_undo_transaction_id uuid,
    consumer_terminal_custody bigint,
    consumer_terminal_sequence bigint,
    CONSTRAINT identity_binding_consumer_terminal_pair CHECK (((consumer_terminal_custody IS NULL) = (consumer_terminal_sequence IS NULL))),
    CONSTRAINT identity_binding_consumer_undo_pair CHECK (((consumer_undo_generation IS NULL) = (consumer_undo_transaction_id IS NULL))),
    CONSTRAINT identity_epoch_receipt_binding_check CHECK (((accepted_job IS NULL) = (accepted_epoch IS NULL))),
    CONSTRAINT identity_epoch_receipt_binding_check1 CHECK (((state = 'accepted'::text) = (accepted_job IS NOT NULL))),
    CONSTRAINT identity_epoch_receipt_binding_consumer_terminal_sequence_check CHECK ((consumer_terminal_sequence > 0)),
    CONSTRAINT identity_epoch_receipt_binding_consumer_undo_generation_check CHECK ((consumer_undo_generation >= 0)),
    CONSTRAINT identity_epoch_receipt_binding_generation_check CHECK ((generation > 0)),
    CONSTRAINT identity_epoch_receipt_binding_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_receipt_binding_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'accepted'::text, 'not-applied'::text])))
);


--
-- Name: identity_epoch_receipt_claim; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receipt_claim (
    partition_no integer NOT NULL,
    receipt_key text NOT NULL,
    generation bigint NOT NULL,
    intent_digest text NOT NULL,
    receipt jsonb NOT NULL,
    intent jsonb NOT NULL,
    job_id uuid NOT NULL,
    job_home integer NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    sources jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    imported boolean DEFAULT false NOT NULL
);


--
-- Name: identity_epoch_receipt_claim_commit; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receipt_claim_commit (
    partition_no integer NOT NULL,
    receipt_key text NOT NULL,
    generation bigint NOT NULL,
    transaction_id uuid NOT NULL
);


--
-- Name: identity_epoch_receipt_closure; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receipt_closure (
    partition_no integer NOT NULL,
    receipt_key text NOT NULL,
    generation bigint NOT NULL,
    resource_home integer NOT NULL,
    transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL
);


--
-- Name: identity_epoch_receiving_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receiving_custody (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    effect_key text NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: identity_epoch_receiving_effect; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receiving_effect (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    effect_key text NOT NULL,
    transaction_id uuid NOT NULL,
    frontier jsonb NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_receiving_effect_frontier_check CHECK (((octet_length((frontier)::text) <= 2048) AND (jsonb_array_length((frontier -> 'after'::text)) <= 8)))
);


--
-- Name: identity_epoch_receiving_gate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receiving_gate (
    partition_no integer NOT NULL,
    owner_id uuid NOT NULL,
    original uuid NOT NULL,
    owner_epoch integer NOT NULL,
    pending_job uuid,
    pending_epoch bigint,
    CONSTRAINT identity_epoch_receiving_gate_check CHECK (((pending_job IS NULL) = (pending_epoch IS NULL))),
    CONSTRAINT identity_epoch_receiving_gate_check1 CHECK ((partition_no = (((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)) / 16))),
    CONSTRAINT identity_epoch_receiving_gate_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_epoch_receiving_plan; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receiving_plan (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    effect_key text NOT NULL,
    binding jsonb NOT NULL,
    binding_digest text NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_receiving_plan_binding_check CHECK ((octet_length((binding)::text) <= 4096)),
    CONSTRAINT identity_epoch_receiving_plan_effect_key_check CHECK (((octet_length(effect_key) >= 1) AND (octet_length(effect_key) <= 256))),
    CONSTRAINT identity_epoch_receiving_plan_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_epoch_receiving_plan_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_epoch_receiving_record; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receiving_record (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    effect_key text NOT NULL,
    owner_id uuid NOT NULL,
    original uuid NOT NULL,
    owner_epoch integer NOT NULL,
    binding jsonb NOT NULL,
    binding_digest text NOT NULL,
    plan jsonb NOT NULL,
    source_hold jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    native_hold jsonb,
    CONSTRAINT identity_epoch_receiving_native_variant CHECK (COALESCE(((((binding ->> 'step'::text) = 'library-private-follow-counts'::text) AND (native_hold IS NULL)) OR (((binding ->> 'step'::text) = 'search-canonical-index'::text) AND (native_hold IS NOT NULL) AND (jsonb_typeof(native_hold) = 'object'::text) AND (octet_length((native_hold)::text) <= 4096) AND ((native_hold -> 'source'::text) = (binding -> 'source'::text)) AND ((native_hold -> 'locator'::text) = ((binding -> 'source'::text) -> 'locator'::text)) AND ((native_hold ->> 'holdId'::text) IS NOT NULL))), false)),
    CONSTRAINT identity_epoch_receiving_record_binding_check CHECK ((octet_length((binding)::text) <= 4096)),
    CONSTRAINT identity_epoch_receiving_record_effect_key_check CHECK (((octet_length(effect_key) >= 1) AND (octet_length(effect_key) <= 256))),
    CONSTRAINT identity_epoch_receiving_record_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_epoch_receiving_record_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_epoch_receiving_search_progress; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_receiving_search_progress (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    effect_key text NOT NULL,
    owner_id uuid NOT NULL,
    original uuid NOT NULL,
    accepted_transaction_id uuid CONSTRAINT identity_epoch_receiving_searc_accepted_transaction_id_not_null NOT NULL,
    binding_digest text CONSTRAINT identity_epoch_receiving_search_progres_binding_digest_not_null NOT NULL,
    applied_transaction_id uuid,
    released_transaction_id uuid,
    revision bigint DEFAULT 0 NOT NULL,
    after_key text,
    state text DEFAULT 'progress'::text NOT NULL,
    CONSTRAINT identity_epoch_receiving_search_progress_after_key_check CHECK (((octet_length(after_key) >= 1) AND (octet_length(after_key) <= 2048))),
    CONSTRAINT identity_epoch_receiving_search_progress_check CHECK (((state = 'progress'::text) OR (applied_transaction_id IS NOT NULL))),
    CONSTRAINT identity_epoch_receiving_search_progress_check1 CHECK (((state = 'released'::text) = (released_transaction_id IS NOT NULL))),
    CONSTRAINT identity_epoch_receiving_search_progress_revision_check CHECK ((revision >= 0)),
    CONSTRAINT identity_epoch_receiving_search_progress_state_check CHECK ((state = ANY (ARRAY['progress'::text, 'settled'::text, 'released'::text])))
);


--
-- Name: identity_epoch_source_consumer_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_source_consumer_custody (
    partition_no integer NOT NULL,
    receipt_key text NOT NULL,
    source_digest text NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_transaction_id uuid CONSTRAINT identity_epoch_source_consumer_c_source_transaction_id_not_null NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    barrier_account_id uuid CONSTRAINT identity_epoch_source_consumer_cust_barrier_account_id_not_null NOT NULL,
    barrier_account_route integer CONSTRAINT identity_epoch_source_consumer_c_barrier_account_route_not_null NOT NULL,
    barrier_version integer NOT NULL,
    barrier_at timestamp with time zone NOT NULL,
    erased_role text NOT NULL,
    binding_generation bigint CONSTRAINT identity_epoch_source_consumer_cust_binding_generation_not_null NOT NULL,
    binding_transaction_id uuid CONSTRAINT identity_epoch_source_consumer__binding_transaction_id_not_null NOT NULL,
    scope_digest text NOT NULL,
    owner_epoch integer NOT NULL,
    transaction_id uuid NOT NULL,
    state text DEFAULT 'retained'::text NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_source_consumer_cust_barrier_account_route_check CHECK (((barrier_account_route >= 0) AND (barrier_account_route <= 65535))),
    CONSTRAINT identity_epoch_source_consumer_custody_barrier_version_check CHECK ((barrier_version > 0)),
    CONSTRAINT identity_epoch_source_consumer_custody_binding_generation_check CHECK ((binding_generation > 0)),
    CONSTRAINT identity_epoch_source_consumer_custody_check CHECK ((barrier_account_route = ((get_byte(uuid_send(barrier_account_id), 10) * 256) + get_byte(uuid_send(barrier_account_id), 11)))),
    CONSTRAINT identity_epoch_source_consumer_custody_erased_role_check CHECK ((erased_role = ANY (ARRAY['subject'::text, 'requester'::text, 'decider'::text]))),
    CONSTRAINT identity_epoch_source_consumer_custody_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_epoch_source_consumer_custody_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT identity_epoch_source_consumer_custody_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_source_consumer_custody_receipt_key_check CHECK ((octet_length(receipt_key) <= 160)),
    CONSTRAINT identity_epoch_source_consumer_custody_scope_digest_check CHECK ((octet_length(scope_digest) <= 128)),
    CONSTRAINT identity_epoch_source_consumer_custody_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT identity_epoch_source_consumer_custody_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT identity_epoch_source_consumer_custody_source_position_check CHECK ((source_position > 0)),
    CONSTRAINT identity_epoch_source_consumer_custody_state_check CHECK ((state = 'retained'::text))
);


--
-- Name: identity_epoch_source_consumer_terminal; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_source_consumer_terminal (
    partition_no integer NOT NULL,
    custody_key bigint NOT NULL,
    sequence bigint NOT NULL,
    previous_sequence bigint,
    state text NOT NULL,
    directory_after jsonb,
    ticket_key text,
    effect_after jsonb,
    seal_digest text,
    scope_partition integer,
    scope_epoch integer,
    scope_position bigint,
    scope_transaction_id uuid,
    replay_generation bigint CONSTRAINT identity_epoch_source_consumer_termi_replay_generation_not_null NOT NULL,
    undo_generation bigint CONSTRAINT identity_epoch_source_consumer_termina_undo_generation_not_null NOT NULL,
    restore_generation bigint CONSTRAINT identity_epoch_source_consumer_term_restore_generation_not_null NOT NULL,
    owner_epoch integer NOT NULL,
    transaction_id uuid NOT NULL,
    receiving_partition integer,
    receiving_epoch integer,
    receiving_position bigint,
    receiving_transaction_id uuid,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_source_consumer_termin_receiving_partition_check CHECK (((receiving_partition >= 0) AND (receiving_partition <= 4095))),
    CONSTRAINT identity_epoch_source_consumer_termina_receiving_position_check CHECK ((receiving_position > 0)),
    CONSTRAINT identity_epoch_source_consumer_termina_restore_generation_check CHECK ((restore_generation >= 0)),
    CONSTRAINT identity_epoch_source_consumer_terminal_check CHECK ((((sequence = 1) AND (previous_sequence IS NULL)) OR ((sequence > 1) AND (previous_sequence IS NOT NULL) AND (previous_sequence = (sequence - 1))))),
    CONSTRAINT identity_epoch_source_consumer_terminal_check1 CHECK (((COALESCE((jsonb_array_length((directory_after -> 'after'::text)) + 1), 0) +
CASE
    WHEN (effect_after IS NULL) THEN 0
    ELSE 2
END) <= 8)),
    CONSTRAINT identity_epoch_source_consumer_terminal_check2 CHECK ((octet_length((jsonb_build_array(directory_after, effect_after))::text) <= 2048)),
    CONSTRAINT identity_epoch_source_consumer_terminal_check3 CHECK ((((scope_partition IS NULL) AND (scope_epoch IS NULL) AND (scope_position IS NULL) AND (scope_transaction_id IS NULL)) OR ((scope_partition IS NOT NULL) AND (scope_epoch IS NOT NULL) AND (scope_position IS NOT NULL) AND (scope_transaction_id IS NOT NULL)))),
    CONSTRAINT identity_epoch_source_consumer_terminal_check4 CHECK ((((state = 'transferred'::text) AND (receiving_partition = partition_no) AND (receiving_epoch = owner_epoch) AND (receiving_partition IS NOT NULL) AND (receiving_epoch IS NOT NULL) AND (receiving_position IS NOT NULL) AND (receiving_transaction_id IS NOT NULL)) OR ((state <> 'transferred'::text) AND (receiving_partition IS NULL) AND (receiving_epoch IS NULL) AND (receiving_position IS NULL) AND (receiving_transaction_id IS NULL)))),
    CONSTRAINT identity_epoch_source_consumer_terminal_check5 CHECK (((state = 'scope'::text) OR (effect_after IS NULL))),
    CONSTRAINT identity_epoch_source_consumer_terminal_check6 CHECK (((state <> ALL (ARRAY['discharged'::text, 'transferred'::text])) OR (directory_after IS NOT NULL))),
    CONSTRAINT identity_epoch_source_consumer_terminal_check7 CHECK (((scope_transaction_id IS NULL) OR ((ticket_key IS NOT NULL) AND (seal_digest IS NOT NULL)))),
    CONSTRAINT identity_epoch_source_consumer_terminal_directory_after_check CHECK (((directory_after IS NULL) OR ((jsonb_typeof(directory_after) = 'object'::text) AND (jsonb_typeof((directory_after -> 'after'::text)) = 'array'::text) AND (jsonb_array_length((directory_after -> 'after'::text)) <= 8)))),
    CONSTRAINT identity_epoch_source_consumer_terminal_effect_after_check CHECK (((effect_after IS NULL) OR ((jsonb_typeof(effect_after) = 'object'::text) AND (effect_after ? 'effectKey'::text) AND ((effect_after ->> 'disposition'::text) = ANY (ARRAY['OLD'::text, 'NEW'::text, 'first-apply'::text, 'handoff'::text]))))),
    CONSTRAINT identity_epoch_source_consumer_terminal_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT identity_epoch_source_consumer_terminal_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_source_consumer_terminal_receiving_epoch_check CHECK ((receiving_epoch > 0)),
    CONSTRAINT identity_epoch_source_consumer_terminal_replay_generation_check CHECK ((replay_generation >= 0)),
    CONSTRAINT identity_epoch_source_consumer_terminal_scope_epoch_check CHECK ((scope_epoch > 0)),
    CONSTRAINT identity_epoch_source_consumer_terminal_scope_partition_check CHECK (((scope_partition >= 0) AND (scope_partition <= 4095))),
    CONSTRAINT identity_epoch_source_consumer_terminal_scope_position_check CHECK ((scope_position > 0)),
    CONSTRAINT identity_epoch_source_consumer_terminal_seal_digest_check CHECK ((seal_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT identity_epoch_source_consumer_terminal_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT identity_epoch_source_consumer_terminal_state_check CHECK ((state = ANY (ARRAY['scope'::text, 'directory'::text, 'discharged'::text, 'transferred'::text]))),
    CONSTRAINT identity_epoch_source_consumer_terminal_ticket_key_check CHECK ((ticket_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT identity_epoch_source_consumer_terminal_undo_generation_check CHECK ((undo_generation >= 0))
);


--
-- Name: identity_epoch_step; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_step (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    step text NOT NULL,
    version integer NOT NULL,
    scope_digest text NOT NULL,
    frontier jsonb NOT NULL,
    state text NOT NULL,
    work jsonb NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT identity_epoch_step_frontier_check CHECK (((octet_length((frontier)::text) <= 2048) AND (jsonb_array_length((frontier -> 'after'::text)) <= 8))),
    CONSTRAINT identity_epoch_step_state_check CHECK ((state = ANY (ARRAY['more'::text, 'complete'::text]))),
    CONSTRAINT identity_epoch_step_step_check CHECK ((step = ANY (ARRAY['mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text]))),
    CONSTRAINT identity_epoch_step_version_check CHECK ((version = 1))
);


--
-- Name: identity_epoch_topology_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_topology_custody (
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL,
    source_epoch integer NOT NULL,
    source_transaction_id uuid NOT NULL,
    source_position bigint NOT NULL,
    partition_no integer NOT NULL,
    CONSTRAINT identity_epoch_topology_custody_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT identity_epoch_topology_custody_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095)))
);


--
-- Name: identity_public_capture; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_capture (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    source_id text NOT NULL,
    source_epoch integer NOT NULL,
    configuration text NOT NULL,
    read_definition text NOT NULL,
    definition_digest text NOT NULL,
    home integer DEFAULT 0 NOT NULL,
    after_route integer,
    after_id uuid,
    version bigint DEFAULT 1 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    transaction_id uuid,
    CONSTRAINT identity_public_capture_home_check CHECK (((home >= 0) AND (home <= 4096)))
);


--
-- Name: identity_public_capture_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_capture_home (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    home integer NOT NULL,
    owner_epoch integer NOT NULL,
    writer_revision bigint NOT NULL,
    complete boolean DEFAULT false NOT NULL
);


--
-- Name: identity_public_capture_key; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_capture_key (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    original uuid NOT NULL
);


--
-- Name: identity_public_capture_page; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_capture_page (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    page_version bigint NOT NULL,
    payload jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_capture_page_payload_check CHECK ((octet_length((payload)::text) <= 4096))
);


--
-- Name: identity_public_dirty; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_dirty (
    partition_no integer NOT NULL,
    original uuid NOT NULL,
    revision bigint NOT NULL
);


--
-- Name: identity_public_output_accepted; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_accepted (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    binding_digest text NOT NULL,
    definition_digest text NOT NULL,
    binding jsonb NOT NULL,
    definition jsonb NOT NULL,
    scope_key text NOT NULL,
    reservation_id text NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_accepted_binding_check CHECK ((octet_length((binding)::text) <= 16384)),
    CONSTRAINT identity_public_output_accepted_definition_check CHECK ((octet_length((definition)::text) <= 2097152)),
    CONSTRAINT identity_public_output_accepted_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_accepted_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_accepted_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_public_output_accepted_reservation_id_check CHECK ((octet_length(reservation_id) <= 256)),
    CONSTRAINT identity_public_output_accepted_scope_key_check CHECK ((scope_key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: identity_public_output_consumer; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_consumer (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    consumer_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_consumer_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_consumer_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_consumer_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_disposition; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_disposition (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    binding_digest text NOT NULL,
    kind text NOT NULL,
    manifest_digest text,
    seal_transaction_id uuid,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_disposition_kind_check CHECK ((kind = ANY (ARRAY['applied'::text, 'cancelled'::text]))),
    CONSTRAINT identity_public_output_disposition_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_disposition_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_disposition_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_fence; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_fence (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    kind text NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_fence_kind_check CHECK ((kind = ANY (ARRAY['applied'::text, 'cancelled'::text]))),
    CONSTRAINT identity_public_output_fence_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_fence_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_fence_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_gate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_gate (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    original_epoch bigint NOT NULL,
    receiving_epoch bigint NOT NULL,
    enrolled_count bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    native_epoch integer,
    native_position bigint,
    transaction_id uuid,
    native_xid xid8,
    CONSTRAINT identity_public_output_gate_check CHECK ((((state = 'open'::text) AND (receiving_epoch = original_epoch) AND (transaction_id IS NULL) AND (native_epoch IS NULL) AND (native_position IS NULL) AND (native_xid IS NULL)) OR ((state <> 'open'::text) AND (receiving_epoch = (original_epoch + 1)) AND (transaction_id IS NOT NULL) AND (native_epoch IS NOT NULL) AND (native_position > 0) AND (native_xid IS NOT NULL)))),
    CONSTRAINT identity_public_output_gate_enrolled_count_check CHECK ((enrolled_count >= 0)),
    CONSTRAINT identity_public_output_gate_original_epoch_check CHECK ((original_epoch > 0)),
    CONSTRAINT identity_public_output_gate_state_check CHECK ((state = ANY (ARRAY['open'::text, 'applied'::text, 'cancelled'::text])))
);


--
-- Name: identity_public_output_member; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_member (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    terminal uuid NOT NULL,
    CONSTRAINT identity_public_output_member_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_original; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_original (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    mapping_epoch bigint NOT NULL,
    CONSTRAINT identity_public_output_original_mapping_epoch_check CHECK ((mapping_epoch > 0)),
    CONSTRAINT identity_public_output_original_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_page; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_page (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    version bigint NOT NULL,
    predecessor text NOT NULL,
    manifest_digest text NOT NULL,
    body jsonb NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_page_body_check CHECK ((octet_length((body)::text) <= 65536)),
    CONSTRAINT identity_public_output_page_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_page_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_page_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_public_output_page_version_check CHECK ((version > 0))
);


--
-- Name: identity_public_output_progress; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_progress (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    after_key jsonb,
    exhausted boolean DEFAULT false NOT NULL,
    manifest_digest text NOT NULL,
    raw_count bigint DEFAULT 0 NOT NULL,
    canonical_count bigint DEFAULT 0 NOT NULL,
    pending jsonb,
    closure_after bigint DEFAULT 0 NOT NULL,
    CONSTRAINT identity_public_output_progress_canonical_count_check CHECK ((canonical_count >= 0)),
    CONSTRAINT identity_public_output_progress_closure_after_check CHECK ((closure_after >= 0)),
    CONSTRAINT identity_public_output_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_public_output_progress_pending_check CHECK ((octet_length((pending)::text) <= 65536)),
    CONSTRAINT identity_public_output_progress_raw_count_check CHECK ((raw_count >= 0)),
    CONSTRAINT identity_public_output_progress_version_check CHECK ((version >= 0))
);


--
-- Name: identity_public_output_seal; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_seal (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    manifest_digest text NOT NULL,
    version bigint NOT NULL,
    raw_count bigint NOT NULL,
    canonical_count bigint NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_seal_canonical_count_check CHECK ((canonical_count >= 0)),
    CONSTRAINT identity_public_output_seal_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_seal_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_seal_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_public_output_seal_raw_count_check CHECK ((raw_count >= 0)),
    CONSTRAINT identity_public_output_seal_version_check CHECK ((version >= 0))
);


--
-- Name: identity_public_output_stage; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_stage (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    binding_digest text NOT NULL,
    original_receiving_epoch bigint NOT NULL,
    kind text NOT NULL,
    purpose text NOT NULL,
    successor_hold_id uuid,
    cancellation_epoch bigint,
    manifest_digest text,
    seal_transaction_id uuid,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT identity_public_output_stage_check CHECK ((((kind = 'applied'::text) AND (purpose = 'identity-public-output-applied'::text) AND (successor_hold_id IS NOT NULL) AND (successor_hold_id <> hold_id) AND (cancellation_epoch IS NULL) AND (manifest_digest IS NOT NULL) AND (manifest_digest ~ '^[0-9a-f]{64}$'::text) AND (seal_transaction_id IS NOT NULL)) OR ((kind = 'cancelled'::text) AND (purpose = 'identity-public-output-cancelled'::text) AND (successor_hold_id IS NULL) AND (cancellation_epoch IS NOT NULL) AND (cancellation_epoch = (original_receiving_epoch + 1)) AND (manifest_digest IS NULL) AND (seal_transaction_id IS NULL)))),
    CONSTRAINT identity_public_output_stage_kind_check CHECK ((kind = ANY (ARRAY['applied'::text, 'cancelled'::text]))),
    CONSTRAINT identity_public_output_stage_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_stage_original_receiving_epoch_check CHECK ((original_receiving_epoch > 0))
);


--
-- Name: identity_public_output_subject_cut; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_subject_cut (
    partition_no integer NOT NULL,
    capture_partition integer NOT NULL,
    capture_id uuid NOT NULL,
    original uuid NOT NULL,
    generation uuid NOT NULL,
    terminal uuid NOT NULL,
    mapping_epoch bigint NOT NULL,
    scope_key text NOT NULL,
    registration uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_subject_cut_mapping_epoch_check CHECK ((mapping_epoch > 0)),
    CONSTRAINT identity_public_output_subject_cut_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_subject_cut_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_subject_cut_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_subject_release; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_subject_release (
    partition_no integer NOT NULL,
    capture_partition integer CONSTRAINT identity_public_output_subject_relea_capture_partition_not_null NOT NULL,
    capture_id uuid NOT NULL,
    original uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_subject_release_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_subject_release_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_subject_release_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_subject_slot; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_subject_slot (
    partition_no integer NOT NULL,
    capture_partition integer NOT NULL,
    capture_id uuid NOT NULL,
    original uuid NOT NULL,
    generation uuid NOT NULL,
    terminal uuid NOT NULL,
    released boolean NOT NULL,
    CONSTRAINT identity_public_output_subject_slot_capture_partition_check CHECK (((capture_partition >= 0) AND (capture_partition <= 4095))),
    CONSTRAINT identity_public_output_subject_slot_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_output_transition; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_output_transition (
    partition_no integer NOT NULL,
    capture_id uuid NOT NULL,
    kind text NOT NULL,
    successor_hold_id uuid,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_public_output_transition_check CHECK (((kind = 'applied'::text) = (successor_hold_id IS NOT NULL))),
    CONSTRAINT identity_public_output_transition_kind_check CHECK ((kind = ANY (ARRAY['applied'::text, 'cancelled'::text]))),
    CONSTRAINT identity_public_output_transition_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_public_output_transition_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_public_output_transition_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_public_writer; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_public_writer (
    partition_no integer NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
);


--
-- Name: identity_receiving_capture_pending; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_receiving_capture_pending (
    transaction_xid text NOT NULL,
    ordinal bigint NOT NULL,
    partition_no integer NOT NULL,
    store text NOT NULL,
    record_key bigint NOT NULL,
    job_id uuid,
    source_transaction_id uuid,
    native_transaction_id uuid,
    copy_roles bigint,
    source_roles bigint,
    basis_locators integer,
    basis_bytes integer,
    armed boolean DEFAULT false NOT NULL,
    native_basis_locators integer,
    native_basis_bytes integer,
    copy_identity text,
    source_identity text,
    CONSTRAINT identity_receiving_capture_native_basis CHECK (((NOT armed) OR (((native_basis_locators IS NULL) OR ((native_basis_locators >= 0) AND (native_basis_locators <= 5))) AND ((native_basis_bytes IS NULL) OR (native_basis_bytes = ANY (ARRAY[0, 92]))) AND ((native_basis_locators IS NULL) = (native_basis_bytes IS NULL)) AND (((native_transaction_id IS NOT NULL) AND (native_transaction_id IS DISTINCT FROM source_transaction_id)) OR (native_basis_locators IS NULL))))),
    CONSTRAINT identity_receiving_capture_original_identity CHECK (((NOT armed) OR ((copy_identity IS NOT NULL) AND (copy_identity ~ '^[0-9a-f]{64}$'::text) AND (source_identity IS NOT NULL) AND (source_identity ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT identity_receiving_capture_pending_check CHECK (((NOT armed) OR ((source_transaction_id IS NOT NULL) AND (copy_roles IS NOT NULL) AND (source_roles IS NOT NULL) AND (copy_roles >= 0) AND (source_roles >= 0) AND ((basis_locators IS NULL) OR ((basis_locators >= 0) AND (basis_locators <= 5))) AND ((basis_bytes IS NULL) OR (basis_bytes = ANY (ARRAY[0, 92]))) AND ((basis_locators IS NULL) = (basis_bytes IS NULL))))),
    CONSTRAINT identity_receiving_capture_pending_store_check CHECK ((store = ANY (ARRAY['identity_epoch_receiving_plan'::text, 'identity_epoch_receiving_record'::text, 'identity_epoch_receiving_effect'::text, 'identity_epoch_receiving_custody'::text, 'identity_epoch_effect_receipt'::text, 'identity_epoch_step'::text])))
);


--
-- Name: identity_receiving_capture_pending_ordinal_seq; Type: SEQUENCE; Schema: semantic; Owner: -
--

ALTER TABLE semantic.identity_receiving_capture_pending ALTER COLUMN ordinal ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME semantic.identity_receiving_capture_pending_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: identity_scope_attempt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_attempt (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    attempt jsonb NOT NULL,
    state text NOT NULL,
    transaction_id uuid NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT identity_scope_attempt_state_check CHECK ((state = ANY (ARRAY['active'::text, 'finished'::text, 'cancelled'::text])))
);


--
-- Name: identity_scope_bridge; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_bridge (
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    closed_job uuid,
    closed_epoch bigint,
    version bigint DEFAULT 1 NOT NULL,
    seal_transaction uuid,
    CONSTRAINT identity_scope_bridge_check CHECK (((closed_job IS NULL) = (closed_epoch IS NULL)))
);


--
-- Name: identity_scope_completion; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_completion (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    source_generation text NOT NULL,
    capture_id uuid NOT NULL,
    attempt jsonb NOT NULL,
    seal jsonb,
    after_key jsonb,
    version bigint DEFAULT 1 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_scope_completion_after_key_check CHECK ((octet_length((after_key)::text) <= 512)),
    CONSTRAINT identity_scope_completion_attempt_check CHECK ((octet_length((attempt)::text) <= 1024)),
    CONSTRAINT identity_scope_completion_seal_check CHECK ((octet_length((seal)::text) <= 4096)),
    CONSTRAINT identity_scope_completion_version_check CHECK ((version > 0))
);


--
-- Name: identity_scope_consumer_fence; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_consumer_fence (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    capture_id uuid NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    attempt jsonb NOT NULL,
    source_generation text NOT NULL,
    completion_version bigint NOT NULL,
    seal_digest text NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_scope_consumer_fence_attempt_check CHECK ((octet_length((attempt)::text) <= 1024)),
    CONSTRAINT identity_scope_consumer_fence_completion_version_check CHECK ((completion_version > 0)),
    CONSTRAINT identity_scope_consumer_fence_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_scope_consumer_fence_native_epoch_check CHECK ((native_epoch > 0)),
    CONSTRAINT identity_scope_consumer_fence_native_position_check CHECK ((native_position > 0)),
    CONSTRAINT identity_scope_consumer_fence_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_scope_consumer_fence_scope_id_check CHECK (((octet_length(scope_id) >= 1) AND (octet_length(scope_id) <= 256))),
    CONSTRAINT identity_scope_consumer_fence_seal_digest_check CHECK ((seal_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT identity_scope_consumer_fence_source_generation_check CHECK (((octet_length(source_generation) >= 1) AND (octet_length(source_generation) <= 256))),
    CONSTRAINT identity_scope_consumer_fence_source_key_check CHECK ((source_key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: identity_scope_directory_release; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_directory_release (
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    original uuid NOT NULL,
    source_partition integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    capture_id uuid NOT NULL,
    transaction_id uuid NOT NULL
);


--
-- Name: identity_scope_forward; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_forward (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    dependency text NOT NULL,
    original uuid,
    dependency_home integer,
    ticket jsonb,
    sending_known boolean DEFAULT true NOT NULL,
    directory_home integer,
    directory_generation uuid,
    directory_group uuid,
    CONSTRAINT identity_scope_directory_intent CHECK ((((directory_home IS NULL) AND (directory_generation IS NULL) AND (directory_group IS NULL)) OR ((directory_home IS NOT NULL) AND (directory_generation IS NOT NULL) AND (directory_group IS NOT NULL)))),
    CONSTRAINT identity_scope_forward_directory_home_check CHECK (((directory_home >= 0) AND (directory_home <= 4095)))
);


--
-- Name: identity_scope_inverse; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_inverse (
    partition_no integer NOT NULL,
    generation uuid NOT NULL,
    original uuid NOT NULL,
    source_partition integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    capture_id uuid NOT NULL,
    source jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_scope_inverse_source_check CHECK ((octet_length((source)::text) <= 4096))
);


--
-- Name: identity_scope_native_association; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_native_association (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    capture_id uuid NOT NULL,
    revision bigint NOT NULL,
    phase text NOT NULL,
    scan_complete boolean NOT NULL,
    job_id uuid,
    job_epoch bigint,
    attempt jsonb,
    completion_version bigint,
    source jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    purpose text NOT NULL,
    CONSTRAINT identity_scope_native_association_attempt_check CHECK ((octet_length((attempt)::text) <= 1024)),
    CONSTRAINT identity_scope_native_association_check CHECK (((job_id IS NULL) = (job_epoch IS NULL))),
    CONSTRAINT identity_scope_native_association_check1 CHECK (((phase <> 'finish'::text) OR ((job_id IS NOT NULL) AND (attempt IS NOT NULL) AND (completion_version IS NOT NULL)))),
    CONSTRAINT identity_scope_native_association_completion_version_check CHECK ((completion_version > 0)),
    CONSTRAINT identity_scope_native_association_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT identity_scope_native_association_job_epoch_check CHECK ((job_epoch > 0)),
    CONSTRAINT identity_scope_native_association_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_scope_native_association_phase_check CHECK ((phase = ANY (ARRAY['registration'::text, 'capture'::text, 'enrollment'::text, 'ready'::text, 'progress'::text, 'finish'::text]))),
    CONSTRAINT identity_scope_native_association_position_check CHECK (("position" > 0)),
    CONSTRAINT identity_scope_native_association_purpose_check CHECK ((purpose = ANY (ARRAY['identity-scope-registration'::text, 'identity-scope-enrollment'::text, 'identity-scope-finish'::text]))),
    CONSTRAINT identity_scope_native_association_revision_check CHECK ((revision > 0)),
    CONSTRAINT identity_scope_native_association_scope_id_check CHECK (((octet_length(scope_id) >= 1) AND (octet_length(scope_id) <= 256))),
    CONSTRAINT identity_scope_native_association_source_check CHECK ((octet_length((source)::text) <= 4096)),
    CONSTRAINT identity_scope_native_association_source_key_check CHECK (((octet_length(source_key) >= 1) AND (octet_length(source_key) <= 256)))
);


--
-- Name: identity_scope_prearm_receipt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_prearm_receipt (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    registration uuid NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    directory_transaction uuid NOT NULL,
    page_id text NOT NULL,
    ordinal integer NOT NULL,
    disposition text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT identity_scope_prearm_receipt_disposition_check CHECK ((disposition = ANY (ARRAY['unsafe'::text, 'cancelled'::text]))),
    CONSTRAINT identity_scope_prearm_receipt_ordinal_check CHECK ((ordinal >= 0))
);


--
-- Name: identity_scope_repair_cursor; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_repair_cursor (
    partition_no integer NOT NULL,
    next_home integer DEFAULT 0 NOT NULL,
    source_key text DEFAULT ''::text NOT NULL,
    scope_id text DEFAULT ''::text NOT NULL,
    CONSTRAINT identity_scope_repair_cursor_next_home_check CHECK (((next_home >= 0) AND (next_home <= 4095))),
    CONSTRAINT identity_scope_repair_cursor_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: identity_scope_summary; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_scope_summary (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    scope_id text NOT NULL,
    source jsonb NOT NULL,
    registration uuid DEFAULT gen_random_uuid() NOT NULL,
    capture_id uuid NOT NULL,
    capture jsonb NOT NULL,
    state text DEFAULT 'capturing'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    active integer DEFAULT 0 NOT NULL,
    frontier jsonb,
    scan_complete boolean DEFAULT false NOT NULL,
    enrollment_home integer DEFAULT 0 NOT NULL,
    maintenance_allowance jsonb,
    CONSTRAINT identity_scope_summary_active_check CHECK ((active >= 0)),
    CONSTRAINT identity_scope_summary_capture_check CHECK ((octet_length((capture)::text) <= 4096)),
    CONSTRAINT identity_scope_summary_enrollment_home_check CHECK (((enrollment_home >= 0) AND (enrollment_home <= 4096))),
    CONSTRAINT identity_scope_summary_maintenance_allowance_check CHECK ((octet_length((maintenance_allowance)::text) <= 2048)),
    CONSTRAINT identity_scope_summary_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_scope_summary_revision_check CHECK ((revision > 0)),
    CONSTRAINT identity_scope_summary_scope_id_check CHECK (((octet_length(scope_id) >= 1) AND (octet_length(scope_id) <= 256))),
    CONSTRAINT identity_scope_summary_source_check CHECK ((octet_length((source)::text) <= 4096)),
    CONSTRAINT identity_scope_summary_state_check CHECK ((state = ANY (ARRAY['capturing'::text, 'enrolling'::text, 'ready'::text, 'repair'::text, 'retiring'::text, 'retired'::text])))
);


--
-- Name: inbound_link; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.inbound_link (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    source_subject_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    source_revision integer NOT NULL,
    present boolean NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    source_security_revision bigint DEFAULT 0 NOT NULL,
    source_type text DEFAULT ''::text NOT NULL,
    order_key text DEFAULT ''::text NOT NULL COLLATE pg_catalog."C",
    filter_value uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    suppressed boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    erasure_roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT inbound_link_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT inbound_link_property_check CHECK ((char_length(property) >= 1)),
    CONSTRAINT inbound_link_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT inbound_link_source_revision_check CHECK ((source_revision >= 1)),
    CONSTRAINT inbound_link_source_security_revision_check CHECK ((source_security_revision >= 0))
);


--
-- Name: inbound_link_context_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.inbound_link_context_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    CONSTRAINT inbound_link_context_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT inbound_link_context_count_context_id_check CHECK ((context_id <> '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT inbound_link_context_count_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: inbound_link_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.inbound_link_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    CONSTRAINT inbound_link_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT inbound_link_count_context_id_check CHECK ((context_id = '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT inbound_link_count_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT inbound_link_count_value_check CHECK ((value >= 0))
);


--
-- Name: kind_type_anchor_fence; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.kind_type_anchor_fence (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT kind_type_anchor_fence_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT kind_type_anchor_fence_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT kind_type_anchor_fence_version_check CHECK ((version >= 0))
);


--
-- Name: kind_type_evidence_body; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.kind_type_evidence_body (
    route integer NOT NULL,
    owner_account_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    preparation_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    binding jsonb NOT NULL,
    body jsonb NOT NULL,
    progress jsonb NOT NULL,
    producer_transaction text NOT NULL,
    CONSTRAINT kind_type_evidence_body_binding_check CHECK (((jsonb_typeof(binding) = 'object'::text) AND (octet_length((binding)::text) <= 16384))),
    CONSTRAINT kind_type_evidence_body_body_check CHECK (((jsonb_typeof(body) = 'object'::text) AND (octet_length((body)::text) <= 16384))),
    CONSTRAINT kind_type_evidence_body_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT kind_type_evidence_body_check1 CHECK ((route = ((get_byte(uuid_send(owner_account_id), 10) * 256) + get_byte(uuid_send(owner_account_id), 11)))),
    CONSTRAINT kind_type_evidence_body_producer_transaction_check CHECK ((producer_transaction ~ '^[0-9]{1,20}$'::text)),
    CONSTRAINT kind_type_evidence_body_progress_check CHECK (((jsonb_typeof(progress) = 'object'::text) AND (octet_length((progress)::text) <= 4096))),
    CONSTRAINT kind_type_evidence_body_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: merge_member; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.merge_member (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    member_id uuid NOT NULL,
    phase text DEFAULT 'links'::text NOT NULL,
    cursor jsonb DEFAULT '[]'::jsonb NOT NULL,
    publication_origin jsonb,
    CONSTRAINT merge_member_phase_check CHECK ((phase = ANY (ARRAY['links'::text, 'outbound'::text, 'members'::text, 'done'::text])))
);


--
-- Name: moderation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.moderation (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    security_revision bigint NOT NULL,
    action text NOT NULL,
    visibility text NOT NULL,
    actor uuid,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    candidate_id uuid,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT moderation_action_check CHECK ((action = ANY (ARRAY['hide'::text, 'take_down'::text, 'restore'::text]))),
    CONSTRAINT moderation_body_check CHECK ((jsonb_typeof(body) = 'object'::text)),
    CONSTRAINT moderation_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT moderation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT moderation_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT moderation_visibility_check CHECK ((visibility = ANY (ARRAY['visible'::text, 'hidden'::text, 'taken_down'::text])))
);


--
-- Name: outbound_link; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.outbound_link (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    order_key text NOT NULL COLLATE pg_catalog."C",
    target_subject_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    relation boolean NOT NULL,
    source_type text DEFAULT ''::text NOT NULL,
    source_order_key text DEFAULT ''::text NOT NULL COLLATE pg_catalog."C",
    outbound_order text,
    source_revision integer NOT NULL,
    source_security_revision bigint DEFAULT 0 NOT NULL,
    target_revision integer DEFAULT 0 NOT NULL,
    target_type text DEFAULT ''::text NOT NULL,
    external text,
    value text NOT NULL,
    present boolean NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    suppressed boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    erasure_roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT outbound_link_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT outbound_link_property_check CHECK ((char_length(property) >= 1)),
    CONSTRAINT outbound_link_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT outbound_link_source_revision_check CHECK ((source_revision >= 1)),
    CONSTRAINT outbound_link_source_security_revision_check CHECK ((source_security_revision >= 0)),
    CONSTRAINT outbound_link_target_revision_check CHECK ((target_revision >= 0)),
    CONSTRAINT outbound_link_value_check CHECK ((value = ANY (ARRAY['value'::text, 'somevalue'::text, 'novalue'::text])))
);


--
-- Name: outbound_link_context_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.outbound_link_context_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    CONSTRAINT outbound_link_context_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT outbound_link_context_count_context_id_check CHECK ((context_id <> '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT outbound_link_context_count_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: outbound_link_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.outbound_link_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    CONSTRAINT outbound_link_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT outbound_link_count_context_id_check CHECK ((context_id = '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT outbound_link_count_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT outbound_link_count_value_check CHECK ((value >= 0))
);


--
-- Name: partition_subjects; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.partition_subjects (
    partition_no integer NOT NULL,
    visible bigint DEFAULT 0 NOT NULL,
    CONSTRAINT partition_subjects_partition_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT partition_subjects_visible_check CHECK ((visible >= 0))
);


--
-- Name: provider_review_queue_bootstrap; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.provider_review_queue_bootstrap (
    partition_no integer NOT NULL,
    source text NOT NULL,
    after_route integer NOT NULL,
    after_key bigint DEFAULT 0 NOT NULL,
    source_epoch integer NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT provider_review_queue_bootstrap_check CHECK (((after_route >= (partition_no * 16)) AND (after_route <= ((partition_no * 16) + 16)))),
    CONSTRAINT provider_review_queue_bootstrap_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT provider_review_queue_bootstrap_source_check CHECK ((source ~ '^[a-z][a-z0-9_-]{0,31}$'::text))
);


--
-- Name: provider_review_queue_entry; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.provider_review_queue_entry (
    route integer NOT NULL,
    source text NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT provider_review_queue_entry_route_check CHECK ((route = 0)),
    CONSTRAINT provider_review_queue_entry_source_check CHECK ((source ~ '^[a-z][a-z0-9_-]{0,31}$'::text))
);


--
-- Name: provider_review_queue_key; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.provider_review_queue_key (
    route integer NOT NULL,
    source text NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    captured_position bigint NOT NULL,
    published boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT provider_review_queue_key_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT provider_review_queue_key_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT provider_review_queue_key_source_check CHECK ((source ~ '^[a-z][a-z0-9_-]{0,31}$'::text))
);


--
-- Name: provider_review_queue_ready; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.provider_review_queue_ready (
    route integer NOT NULL,
    source text NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    CONSTRAINT provider_review_queue_ready_route_check CHECK ((route = 0)),
    CONSTRAINT provider_review_queue_ready_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095)))
);


--
-- Name: public_filter_bootstrap; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_bootstrap (
    partition_no integer NOT NULL,
    bootstrap uuid NOT NULL,
    read_definition uuid NOT NULL,
    request_key text NOT NULL,
    consumer text NOT NULL,
    snapshot_kind text NOT NULL,
    native_snapshot pg_snapshot NOT NULL,
    owner_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    state text NOT NULL,
    account_after integer DEFAULT 0 NOT NULL,
    queried text,
    coverage_generation bigint,
    coverage_after integer DEFAULT 0 NOT NULL,
    coverage_root text,
    coverage_sealed boolean DEFAULT false NOT NULL,
    CONSTRAINT public_filter_bootstrap_account_after_check CHECK (((account_after >= 0) AND (account_after <= 4096))),
    CONSTRAINT public_filter_bootstrap_complete_coverage CHECK (((NOT coverage_sealed) OR ((coverage_after = 4096) AND (coverage_generation IS NOT NULL) AND (coverage_root IS NOT NULL)))),
    CONSTRAINT public_filter_bootstrap_consumer_check CHECK ((octet_length(consumer) <= 16384)),
    CONSTRAINT public_filter_bootstrap_coverage_after_check CHECK (((coverage_after >= 0) AND (coverage_after <= 4096))),
    CONSTRAINT public_filter_bootstrap_coverage_generation_check CHECK ((coverage_generation >= 0)),
    CONSTRAINT public_filter_bootstrap_coverage_root_check CHECK ((coverage_root ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_bootstrap_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_bootstrap_snapshot_kind_check CHECK ((snapshot_kind = ANY (ARRAY['pit'::text, 'prepared'::text]))),
    CONSTRAINT public_filter_bootstrap_state_check CHECK ((state = ANY (ARRAY['capturing'::text, 'begun'::text, 'adopted'::text, 'aborting'::text, 'aborted'::text])))
);


--
-- Name: public_filter_bootstrap_account; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_bootstrap_account (
    partition_no integer NOT NULL,
    bootstrap uuid NOT NULL,
    account_partition integer NOT NULL,
    owner_epoch integer NOT NULL,
    revision bigint NOT NULL,
    claim_revision bigint NOT NULL,
    CONSTRAINT public_filter_bootstrap_account_account_partition_check CHECK (((account_partition >= 0) AND (account_partition <= 4095))),
    CONSTRAINT public_filter_bootstrap_account_claim_revision_check CHECK ((claim_revision > 0)),
    CONSTRAINT public_filter_bootstrap_account_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_bootstrap_account_revision_check CHECK ((revision > 0))
);


--
-- Name: public_filter_home_enrollment; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_home_enrollment (
    partition_no integer NOT NULL,
    bootstrap uuid NOT NULL,
    registration_partition integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    read_definition uuid NOT NULL,
    owner_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    native_revision bigint,
    native_claim_revision bigint,
    key_after text COLLATE pg_catalog."C",
    complete boolean DEFAULT false NOT NULL,
    creation_position bigint,
    native_enqueue_revision bigint,
    key_digest text,
    receipt text,
    creation_consumer text,
    CONSTRAINT public_filter_home_enrollment_check CHECK (((native_revision IS NULL) = (native_claim_revision IS NULL))),
    CONSTRAINT public_filter_home_enrollment_creation_consumer_check CHECK ((creation_consumer ~ '^public_filter_[0-9a-f]{32}$'::text)),
    CONSTRAINT public_filter_home_enrollment_creation_position_check CHECK ((creation_position >= 0)),
    CONSTRAINT public_filter_home_enrollment_key_digest_check CHECK ((key_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_home_enrollment_native_enqueue_revision_check CHECK ((native_enqueue_revision >= 0)),
    CONSTRAINT public_filter_home_enrollment_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_home_enrollment_receipt_check CHECK ((receipt ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_home_enrollment_registration_partition_check CHECK (((registration_partition >= 0) AND (registration_partition <= 4095))),
    CONSTRAINT public_filter_home_enrollment_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: public_filter_key_enrollment; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_key_enrollment (
    partition_no integer NOT NULL,
    input_key text NOT NULL COLLATE pg_catalog."C",
    registration_partition integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    enrollment_generation bigint NOT NULL,
    CONSTRAINT public_filter_key_enrollment_enrollment_generation_check CHECK ((enrollment_generation >= 0))
);


--
-- Name: public_filter_population_start; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_population_start (
    partition_no integer NOT NULL,
    id uuid NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    observation text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    read_definition uuid NOT NULL,
    consumer text NOT NULL,
    covered_generation bigint NOT NULL,
    start_generation bigint NOT NULL,
    owner_epoch integer NOT NULL,
    deadline bigint NOT NULL,
    CONSTRAINT public_filter_population_start_check CHECK ((start_generation >= covered_generation)),
    CONSTRAINT public_filter_population_start_consumer_check CHECK ((octet_length(consumer) <= 8192)),
    CONSTRAINT public_filter_population_start_covered_generation_check CHECK ((covered_generation >= 0)),
    CONSTRAINT public_filter_population_start_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_population_start_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: public_filter_privacy_head; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_privacy_head (
    partition_no integer NOT NULL,
    "position" bigint DEFAULT 0 NOT NULL,
    enrollment_generation bigint DEFAULT 0 NOT NULL,
    owner_epoch integer,
    population_fenced boolean DEFAULT true NOT NULL,
    CONSTRAINT public_filter_privacy_head_enrollment_generation_check CHECK ((enrollment_generation >= 0)),
    CONSTRAINT public_filter_privacy_head_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_privacy_head_position_check CHECK (("position" >= 0))
);


--
-- Name: public_filter_privacy_log; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_privacy_log (
    partition_no integer NOT NULL,
    owner_epoch integer NOT NULL,
    "position" bigint NOT NULL,
    transaction_id uuid NOT NULL,
    cause text NOT NULL,
    affected jsonb NOT NULL,
    impacts jsonb NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    CONSTRAINT public_filter_privacy_log_affected_check CHECK ((jsonb_typeof(affected) = 'array'::text)),
    CONSTRAINT public_filter_privacy_log_cause_check CHECK ((cause = ANY (ARRAY['subject'::text, 'candidate'::text, 'selection'::text, 'sourceTuple'::text, 'consent'::text, 'collection'::text, 'realm'::text, 'board'::text]))),
    CONSTRAINT public_filter_privacy_log_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_privacy_log_impacts_check CHECK ((jsonb_typeof(impacts) = 'array'::text)),
    CONSTRAINT public_filter_privacy_log_position_check CHECK (("position" > 0))
);


--
-- Name: public_filter_privacy_pending; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_privacy_pending (
    partition_no integer NOT NULL,
    input_key text NOT NULL COLLATE pg_catalog."C",
    owner_epoch integer NOT NULL,
    first_position bigint,
    through_position bigint,
    enqueue_revision bigint NOT NULL,
    captured_through bigint,
    captured_revision bigint,
    captured_epoch integer,
    fanout_frontier text,
    live boolean DEFAULT true NOT NULL,
    next_first_position bigint,
    native_captured_enqueue bigint,
    native_captured_epoch integer,
    native_revision bigint,
    native_claim_revision bigint,
    native_transaction xid8,
    captured_native_revision bigint,
    captured_native_claim_revision bigint,
    captured_enrollment_generation bigint,
    CONSTRAINT public_filter_pending_enrollment_window CHECK (((COALESCE(native_captured_enqueue, captured_revision) IS NULL) = (captured_enrollment_generation IS NULL))),
    CONSTRAINT public_filter_pending_native_domain CHECK ((((input_key = '["domain","accounts"]'::text) AND (first_position IS NULL) AND (through_position IS NULL) AND (native_revision IS NOT NULL) AND (native_revision > 0) AND (native_claim_revision IS NOT NULL) AND (native_claim_revision > 0) AND (native_transaction IS NOT NULL)) OR ((input_key <> '["domain","accounts"]'::text) AND (first_position IS NOT NULL) AND (through_position IS NOT NULL) AND (native_revision IS NULL) AND (native_claim_revision IS NULL) AND (native_transaction IS NULL)))),
    CONSTRAINT public_filter_privacy_pendin_captured_enrollment_generati_check CHECK ((captured_enrollment_generation >= 0)),
    CONSTRAINT public_filter_privacy_pending_check CHECK ((through_position >= first_position)),
    CONSTRAINT public_filter_privacy_pending_check1 CHECK (((captured_through IS NULL) = (captured_revision IS NULL))),
    CONSTRAINT public_filter_privacy_pending_check2 CHECK (((captured_through IS NULL) = (captured_epoch IS NULL))),
    CONSTRAINT public_filter_privacy_pending_check3 CHECK (((captured_through IS NULL) OR (((captured_through >= first_position) AND (captured_through <= through_position)) AND (captured_revision > 0) AND (captured_revision <= enqueue_revision) AND (captured_epoch > 0)))),
    CONSTRAINT public_filter_privacy_pending_enqueue_revision_check CHECK ((enqueue_revision > 0)),
    CONSTRAINT public_filter_privacy_pending_first_position_check CHECK ((first_position > 0)),
    CONSTRAINT public_filter_privacy_pending_owner_epoch_check CHECK ((owner_epoch > 0))
);


--
-- Name: public_filter_privacy_subject; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_privacy_subject (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    owner_epoch integer NOT NULL,
    "position" bigint NOT NULL,
    CONSTRAINT public_filter_privacy_subject_check CHECK (((route >= (partition_no * 16)) AND (route < ((partition_no + 1) * 16)))),
    CONSTRAINT public_filter_privacy_subject_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_privacy_subject_position_check CHECK (("position" >= 0))
);


--
-- Name: public_filter_projection_build; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_projection_build (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    meaning_digest text NOT NULL,
    meaning_type text NOT NULL,
    build_id uuid NOT NULL,
    generation bigint NOT NULL,
    owner_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    privacy_position bigint NOT NULL,
    terminal_id uuid NOT NULL,
    subject_revision integer NOT NULL,
    security_revision bigint NOT NULL,
    current_release text NOT NULL,
    CONSTRAINT public_filter_projection_build_check CHECK (((route >= (partition_no * 16)) AND (route < ((partition_no + 1) * 16)))),
    CONSTRAINT public_filter_projection_build_generation_check CHECK ((generation > 0)),
    CONSTRAINT public_filter_projection_build_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_projection_build_privacy_position_check CHECK ((privacy_position >= 0)),
    CONSTRAINT public_filter_projection_build_security_revision_check CHECK ((security_revision >= 0)),
    CONSTRAINT public_filter_projection_build_source_position_check CHECK ((source_position >= 0)),
    CONSTRAINT public_filter_projection_build_subject_revision_check CHECK ((subject_revision > 0))
);


--
-- Name: public_filter_projection_head; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_projection_head (
    build_id uuid NOT NULL,
    partition_no integer NOT NULL,
    owner_epoch integer NOT NULL,
    "position" bigint NOT NULL,
    CONSTRAINT public_filter_projection_head_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_projection_head_position_check CHECK (("position" >= 0))
);


--
-- Name: public_filter_projection_replay; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_projection_replay (
    partition_no integer DEFAULT 0 NOT NULL,
    bootstrap uuid NOT NULL,
    execution text NOT NULL,
    predecessor text NOT NULL,
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    request_digest text NOT NULL,
    page_data text NOT NULL,
    page_digest text NOT NULL,
    CONSTRAINT public_filter_projection_replay_check CHECK (((route >= (partition_no * 16)) AND (route < ((partition_no + 1) * 16)))),
    CONSTRAINT public_filter_projection_replay_execution_check CHECK (((octet_length(execution) >= 1) AND (octet_length(execution) <= 4096))),
    CONSTRAINT public_filter_projection_replay_page_digest_check CHECK ((page_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_projection_replay_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT public_filter_projection_replay_predecessor_check CHECK (((predecessor = ''::text) OR (predecessor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT public_filter_projection_replay_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_projection_replay_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: public_filter_read_definition; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_read_definition (
    partition_no integer NOT NULL,
    read_definition uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    configuration uuid NOT NULL,
    release_digest text NOT NULL,
    subject_type text NOT NULL,
    capture_digest text NOT NULL,
    capture text NOT NULL,
    dependency_keys jsonb NOT NULL,
    coverage_keys text[],
    CONSTRAINT public_filter_read_definition_capture_check CHECK ((octet_length(capture) <= 1048576)),
    CONSTRAINT public_filter_read_definition_dependency_keys_check CHECK ((jsonb_typeof(dependency_keys) = 'array'::text))
);


--
-- Name: public_filter_repair_advance; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_repair_advance (
    partition_no integer NOT NULL,
    bootstrap uuid NOT NULL,
    execution text NOT NULL,
    step uuid NOT NULL,
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    owner_epoch integer NOT NULL,
    "position" bigint NOT NULL,
    transaction_id uuid,
    native_xid xid8,
    CONSTRAINT public_filter_repair_advance_check CHECK (((route / 16) = partition_no)),
    CONSTRAINT public_filter_repair_advance_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT public_filter_repair_advance_position_check CHECK (("position" > 0)),
    CONSTRAINT public_filter_repair_advance_provenance CHECK (((transaction_id IS NULL) = (native_xid IS NULL)))
);


--
-- Name: public_filter_repair_step; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_repair_step (
    partition_no integer NOT NULL,
    bootstrap uuid NOT NULL,
    execution text NOT NULL,
    step uuid NOT NULL,
    predecessor uuid,
    state text NOT NULL,
    complete boolean NOT NULL,
    input_limit integer,
    receipt_protocol integer,
    repair_locator_digests bytea,
    verified_binding text,
    verified_root text,
    verified_ordinal bigint,
    verified_next uuid,
    verified_home integer,
    ack_after integer DEFAULT 0 NOT NULL,
    CONSTRAINT public_filter_repair_ack_proof CHECK (((ack_after = 0) OR (complete AND (verified_root IS NOT NULL) AND (verified_next IS NULL)))),
    CONSTRAINT public_filter_repair_home_proof CHECK (((verified_home IS NULL) OR ((verified_root IS NOT NULL) AND (NOT complete)))),
    CONSTRAINT public_filter_repair_locator_digests_bound CHECK (((repair_locator_digests IS NULL) OR ((input_limit IS NOT NULL) AND (octet_length(repair_locator_digests) <= 8192) AND (mod(octet_length(repair_locator_digests), 32) = 0) AND ((octet_length(repair_locator_digests) / 32) <= input_limit)))),
    CONSTRAINT public_filter_repair_step_ack_after_check CHECK (((ack_after >= 0) AND (ack_after <= 4096))),
    CONSTRAINT public_filter_repair_step_input_limit_check CHECK (((input_limit >= 1) AND (input_limit <= 256))),
    CONSTRAINT public_filter_repair_step_provenance CHECK (((input_limit IS NULL) = (receipt_protocol IS NULL))),
    CONSTRAINT public_filter_repair_step_receipt_protocol_check CHECK ((receipt_protocol = 1)),
    CONSTRAINT public_filter_repair_step_state_check CHECK ((octet_length(state) <= 16384)),
    CONSTRAINT public_filter_repair_step_verified_binding_check CHECK ((verified_binding ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_repair_step_verified_home_check CHECK (((verified_home >= 0) AND (verified_home <= 4095))),
    CONSTRAINT public_filter_repair_step_verified_ordinal_check CHECK ((verified_ordinal > 0)),
    CONSTRAINT public_filter_repair_step_verified_root_check CHECK ((verified_root ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_repair_verified_fields CHECK ((((verified_binding IS NULL) = (verified_root IS NULL)) AND ((verified_binding IS NULL) = (verified_ordinal IS NULL)) AND ((verified_next IS NULL) OR (verified_root IS NOT NULL))))
);


--
-- Name: public_filter_source; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.public_filter_source (
    partition_no integer NOT NULL,
    source_id uuid DEFAULT gen_random_uuid() NOT NULL,
    configuration uuid DEFAULT gen_random_uuid() NOT NULL,
    route_digest text NOT NULL,
    owner_epoch integer NOT NULL,
    family text NOT NULL,
    CONSTRAINT public_filter_source_family_check CHECK ((family = 'global-subject-v1'::text)),
    CONSTRAINT public_filter_source_owner_epoch_check CHECK ((owner_epoch > 0))
);


--
-- Name: record_lifecycle; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_lifecycle (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    revision integer NOT NULL,
    state text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    deletion_generation uuid NOT NULL,
    deletion_transaction_id uuid NOT NULL,
    deleted_at timestamp with time zone NOT NULL,
    purge_after timestamp with time zone NOT NULL,
    held boolean DEFAULT false NOT NULL,
    CONSTRAINT record_lifecycle_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT record_lifecycle_check1 CHECK ((route = ((get_byte(uuid_send(candidate_id), 10) * 256) + get_byte(uuid_send(candidate_id), 11)))),
    CONSTRAINT record_lifecycle_check2 CHECK ((purge_after = (deleted_at + '720:00:00'::interval))),
    CONSTRAINT record_lifecycle_revision_check CHECK ((revision > 0)),
    CONSTRAINT record_lifecycle_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text, 'purging'::text, 'purged'::text]))),
    CONSTRAINT record_lifecycle_version_check CHECK ((version > 0))
);


--
-- Name: record_purge_command; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_purge_command (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    key bigint NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer,
    "position" bigint
);


--
-- Name: record_purge_command_key_seq; Type: SEQUENCE; Schema: semantic; Owner: -
--

ALTER TABLE semantic.record_purge_command ALTER COLUMN key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME semantic.record_purge_command_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: record_purge_hold; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_purge_hold (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    deletion_generation uuid NOT NULL,
    receiving_partition integer NOT NULL,
    receiving_id uuid NOT NULL,
    hold_id uuid NOT NULL,
    route integer NOT NULL,
    kind text NOT NULL,
    owner_id uuid NOT NULL,
    record_id uuid NOT NULL,
    source_epoch integer NOT NULL,
    source jsonb NOT NULL,
    transaction_id uuid NOT NULL,
    released boolean DEFAULT false NOT NULL,
    CONSTRAINT record_purge_hold_check CHECK ((partition_no = (route / 16))),
    CONSTRAINT record_purge_hold_kind_check CHECK ((kind = ANY (ARRAY['contribution'::text, 'context'::text, 'zone'::text]))),
    CONSTRAINT record_purge_hold_receiving_partition_check CHECK (((receiving_partition >= 0) AND (receiving_partition <= 4095)))
);


--
-- Name: record_purge_receiving; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_purge_receiving (
    partition_no integer NOT NULL,
    receiving_id uuid NOT NULL,
    source_key text NOT NULL,
    deletion_generation uuid NOT NULL,
    hold_id uuid NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    receiver_epoch integer NOT NULL,
    source jsonb NOT NULL,
    source_transaction_id uuid NOT NULL,
    accepted_transaction_id uuid NOT NULL,
    completion_transaction_id uuid,
    completion_position bigint,
    CONSTRAINT record_purge_receiving_check CHECK (((completion_position IS NULL) OR (completion_transaction_id IS NOT NULL))),
    CONSTRAINT record_purge_receiving_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: record_purge_writer; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_purge_writer (
    partition_no integer NOT NULL,
    source_key text NOT NULL,
    route integer NOT NULL,
    kind text NOT NULL,
    resource_id uuid NOT NULL,
    enrolled boolean NOT NULL,
    birth_transaction uuid NOT NULL,
    frontier bigint DEFAULT 0 NOT NULL,
    sealed_cut uuid,
    sealed_generation uuid,
    sealed_version text,
    sealed_epoch integer,
    CONSTRAINT record_purge_writer_check CHECK ((partition_no = (route / 16))),
    CONSTRAINT record_purge_writer_kind_check CHECK ((kind = ANY (ARRAY['context'::text, 'zone'::text])))
);


--
-- Name: record_retention_commit; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_retention_commit (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    deletion_generation uuid NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    deleted_at timestamp with time zone NOT NULL,
    purge_after timestamp with time zone NOT NULL
);


--
-- Name: record_retention_document; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_retention_document (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    deletion_generation uuid NOT NULL,
    document_id uuid NOT NULL,
    minimized boolean DEFAULT false NOT NULL
);


--
-- Name: record_retention_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_retention_home (
    partition_no integer NOT NULL,
    after_key bigint DEFAULT 0 NOT NULL,
    CONSTRAINT record_retention_home_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: record_retention_key; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_retention_key (
    partition_no integer NOT NULL,
    key bigint NOT NULL,
    route integer NOT NULL,
    kind text NOT NULL,
    owner_id uuid NOT NULL,
    record_id uuid NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    deleted_at timestamp with time zone NOT NULL,
    phase text DEFAULT 'local'::text NOT NULL,
    fragment_store integer DEFAULT 0 NOT NULL,
    fragment_key bigint DEFAULT 0 NOT NULL,
    CONSTRAINT record_retention_key_check CHECK (((route / 16) = partition_no)),
    CONSTRAINT record_retention_key_fragment_key_check CHECK ((fragment_key >= 0)),
    CONSTRAINT record_retention_key_fragment_store_check CHECK (((fragment_store >= 0) AND (fragment_store <= 9))),
    CONSTRAINT record_retention_key_kind_check CHECK ((kind = ANY (ARRAY['candidate'::text, 'context'::text, 'zone'::text]))),
    CONSTRAINT record_retention_key_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT record_retention_key_phase_check CHECK ((phase = ANY (ARRAY['local'::text, 'shared'::text, 'complete'::text])))
);


--
-- Name: record_retention_key_key_seq; Type: SEQUENCE; Schema: semantic; Owner: -
--

ALTER TABLE semantic.record_retention_key ALTER COLUMN key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME semantic.record_retention_key_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: record_retention_page; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_retention_page (
    partition_no integer NOT NULL,
    key text NOT NULL,
    input_limit integer NOT NULL,
    result jsonb NOT NULL,
    CONSTRAINT record_retention_page_input_limit_check CHECK (((input_limit >= 1) AND (input_limit <= 100))),
    CONSTRAINT record_retention_page_key_check CHECK (((octet_length(key) >= 1) AND (octet_length(key) <= 255)))
);


--
-- Name: record_retention_schedule; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_retention_schedule (
    partition_no integer NOT NULL,
    after_home integer DEFAULT '-1'::integer NOT NULL,
    CONSTRAINT record_retention_schedule_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: record_source_set; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_source_set (
    partition_no integer NOT NULL,
    route integer GENERATED ALWAYS AS ((partition_no * 16)) STORED,
    transaction_id uuid NOT NULL,
    revision integer NOT NULL,
    native_xid text DEFAULT (pg_current_xact_id())::text NOT NULL,
    sealed boolean DEFAULT false NOT NULL,
    digest text,
    members integer DEFAULT 0 NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT record_source_set_check CHECK (((sealed AND (digest ~ '^[0-9a-f]{64}$'::text)) OR ((NOT sealed) AND (digest IS NULL)))),
    CONSTRAINT record_source_set_members_check CHECK (((members >= 0) AND (members <= 512))),
    CONSTRAINT record_source_set_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: record_source_set_member; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.record_source_set_member (
    partition_no integer NOT NULL,
    route integer GENERATED ALWAYS AS ((partition_no * 16)) STORED,
    transaction_id uuid NOT NULL,
    unit_key text NOT NULL COLLATE pg_catalog."C",
    source_key text NOT NULL COLLATE pg_catalog."C",
    source_hash bytea NOT NULL,
    unit_hash bytea NOT NULL,
    kind text NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid,
    source_revision integer NOT NULL,
    document_id uuid,
    field text,
    language text,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT record_source_set_member_check CHECK ((((kind = 'contribution'::text) AND (candidate_id IS NOT NULL) AND (field IS NULL) AND (language IS NULL)) OR ((kind = 'terms'::text) AND (candidate_id IS NULL) AND (document_id IS NULL) AND (field = ANY (ARRAY['labels'::text, 'descriptions'::text, 'aliases'::text])) AND (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'::text)))),
    CONSTRAINT record_source_set_member_kind_check CHECK ((kind = ANY (ARRAY['contribution'::text, 'terms'::text]))),
    CONSTRAINT record_source_set_member_source_revision_check CHECK ((source_revision > 0))
);


--
-- Name: record_source_set_revision_seq; Type: SEQUENCE; Schema: semantic; Owner: -
--

ALTER TABLE semantic.record_source_set ALTER COLUMN revision ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME semantic.record_source_set_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: redirect; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.redirect (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    sequence integer NOT NULL,
    target uuid NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: relation_context_slot; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.relation_context_slot (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    context_id uuid NOT NULL,
    CONSTRAINT relation_context_slot_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT relation_context_slot_context_id_check CHECK ((context_id <> '00000000-0000-8000-8000-000000000000'::uuid))
);


--
-- Name: release_composite; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.release_composite (
    digest text NOT NULL,
    parent_digest text NOT NULL,
    extension_route integer NOT NULL,
    extension_context_id uuid NOT NULL,
    extension_digest text NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT release_composite_digest_check CHECK ((digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT release_composite_parent_digest_check CHECK ((parent_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: resource_record_purge_commit; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.resource_record_purge_commit (
    route integer NOT NULL,
    kind text NOT NULL,
    resource_id uuid NOT NULL,
    deletion_generation uuid NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    source_version bigint NOT NULL,
    deleted_at timestamp with time zone NOT NULL,
    purge_after timestamp with time zone NOT NULL,
    CONSTRAINT resource_record_purge_commit_check CHECK ((purge_after = (deleted_at + '720:00:00'::interval))),
    CONSTRAINT resource_record_purge_commit_kind_check CHECK ((kind = ANY (ARRAY['context'::text, 'zone'::text])))
);


--
-- Name: retraction; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.retraction (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    revision integer NOT NULL,
    "references" jsonb NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT retraction_references_check CHECK ((jsonb_typeof("references") = 'array'::text))
);


--
-- Name: revision; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.revision (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    revision integer NOT NULL,
    kind text NOT NULL,
    release text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    source jsonb,
    verification_receipt_id text,
    revocation_receipt_id text,
    revoked_survivor_id uuid,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    term_changes jsonb,
    term_support integer[],
    CONSTRAINT revision_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'propose'::text, 'accept'::text, 'reject'::text, 'adopt'::text, 'merge'::text, 'retract'::text, 'identity'::text, 'terms'::text]))),
    CONSTRAINT revision_release_check CHECK ((release ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT revision_revision_check CHECK ((revision >= 1)),
    CONSTRAINT revision_revocation_receipt_check CHECK (((revocation_receipt_id IS NULL) OR ((length(revocation_receipt_id) >= 1) AND (length(revocation_receipt_id) <= 255)))),
    CONSTRAINT revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT revision_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT revision_terms_check CHECK (((kind = 'terms'::text) = ((term_changes IS NOT NULL) AND (term_support IS NOT NULL))))
);


--
-- Name: search_relation_probe; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.search_relation_probe (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL COLLATE pg_catalog."C",
    value text NOT NULL COLLATE pg_catalog."C",
    revision integer NOT NULL,
    after_slot uuid NOT NULL,
    after_candidate uuid NOT NULL
);


--
-- Name: search_selected; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.search_selected (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    property text NOT NULL COLLATE pg_catalog."C",
    rank text NOT NULL,
    ordinal integer NOT NULL,
    body jsonb NOT NULL,
    release text NOT NULL,
    revision integer NOT NULL,
    source jsonb,
    relation boolean NOT NULL,
    compact boolean NOT NULL,
    active boolean NOT NULL,
    log_seq integer NOT NULL,
    CONSTRAINT search_selected_rank_check CHECK ((rank = ANY (ARRAY['normal'::text, 'preferred'::text])))
);


--
-- Name: search_selection_retraction; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.search_selection_retraction (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    log_seq integer NOT NULL
);


--
-- Name: search_selection_slot; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.search_selection_slot (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    expanded boolean DEFAULT false NOT NULL,
    head integer DEFAULT 0 NOT NULL
);


--
-- Name: search_selection_state; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.search_selection_state (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    phase text DEFAULT 'facts'::text NOT NULL,
    after_slot uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    after_seq integer DEFAULT 0 NOT NULL,
    CONSTRAINT search_selection_state_phase_check CHECK ((phase = ANY (ARRAY['facts'::text, 'adoptions'::text, 'done'::text])))
);


--
-- Name: source_candidate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.source_candidate (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    field_group text NOT NULL,
    statement_digest text NOT NULL,
    candidate_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT source_candidate_statement_digest_check CHECK ((statement_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: source_record; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.source_record (
    route integer NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    metadata_revision integer NOT NULL,
    record jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT source_record_metadata_revision_check CHECK ((metadata_revision > 0)),
    CONSTRAINT source_record_record_check CHECK ((jsonb_typeof(record) = 'object'::text)),
    CONSTRAINT source_record_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: statement_disclosure; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.statement_disclosure (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    target_id uuid NOT NULL,
    account_id uuid,
    property text NOT NULL,
    disclosed boolean DEFAULT false NOT NULL,
    source_order_key text NOT NULL COLLATE pg_catalog."C",
    target_order_key text NOT NULL COLLATE pg_catalog."C",
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL
);


--
-- Name: subject; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    type text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    visibility text DEFAULT 'visible'::text NOT NULL,
    security_revision bigint DEFAULT 0 NOT NULL,
    current_facts integer DEFAULT 0 NOT NULL,
    current_release text DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'::text NOT NULL,
    projection_pending boolean DEFAULT false NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    CONSTRAINT subject_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_security_revision_check CHECK ((security_revision >= 0)),
    CONSTRAINT subject_type_check CHECK ((type ~ '^[a-z][a-z0-9_]*:[A-Za-z][A-Za-z0-9_]*$'::text)),
    CONSTRAINT subject_visibility_check CHECK ((visibility = ANY (ARRAY['visible'::text, 'hidden'::text, 'taken_down'::text])))
);


--
-- Name: subject_page_bootstrap; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_bootstrap (
    partition_no integer NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    source_key jsonb,
    state text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    worker text,
    lease_until timestamp with time zone,
    CONSTRAINT subject_page_bootstrap_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT subject_page_bootstrap_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'done'::text])))
);


--
-- Name: subject_page_change; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_change (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    "position" bigint NOT NULL,
    change_id text NOT NULL,
    component_kind text,
    component_key text,
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    effective_at timestamp with time zone,
    evidence text NOT NULL,
    CONSTRAINT subject_page_change_check CHECK (((component_kind IS NULL) = (component_key IS NULL))),
    CONSTRAINT subject_page_change_check1 CHECK (((evidence = 'known'::text) = (effective_at IS NOT NULL))),
    CONSTRAINT subject_page_change_component_kind_check CHECK ((component_kind = ANY (ARRAY['label'::text, 'fact'::text, 'cover'::text, 'relation'::text]))),
    CONSTRAINT subject_page_change_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_change_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_page_component; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_component (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    component_kind text NOT NULL,
    component_key text NOT NULL,
    generation bigint NOT NULL,
    shown boolean NOT NULL,
    digest text,
    effective_at timestamp with time zone,
    evidence text NOT NULL,
    last_change_position bigint NOT NULL,
    source_version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT subject_page_component_check CHECK ((shown = (digest IS NOT NULL))),
    CONSTRAINT subject_page_component_check1 CHECK (((evidence = 'known'::text) = (effective_at IS NOT NULL))),
    CONSTRAINT subject_page_component_component_kind_check CHECK ((component_kind = ANY (ARRAY['label'::text, 'fact'::text, 'cover'::text, 'relation'::text]))),
    CONSTRAINT subject_page_component_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_component_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_page_continuation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_continuation (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    kind text NOT NULL,
    change_id text NOT NULL,
    effective_at timestamp with time zone,
    evidence text NOT NULL,
    CONSTRAINT subject_page_continuation_check CHECK (((evidence = 'known'::text) = (effective_at IS NOT NULL))),
    CONSTRAINT subject_page_continuation_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_continuation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_page_delivery; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_delivery (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    owner_kind text NOT NULL,
    owner_route integer NOT NULL,
    owner_key text NOT NULL,
    change_id text NOT NULL,
    event_id text NOT NULL,
    effective_at timestamp with time zone,
    evidence text NOT NULL,
    CONSTRAINT subject_page_delivery_check CHECK (((evidence = 'known'::text) = (effective_at IS NOT NULL))),
    CONSTRAINT subject_page_delivery_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_delivery_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['subject'::text, 'source-fence'::text]))),
    CONSTRAINT subject_page_delivery_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT subject_page_delivery_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_page_dependency; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_dependency (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    owner_kind text NOT NULL,
    owner_route integer NOT NULL,
    owner_key text NOT NULL,
    component_key text NOT NULL,
    source_version bigint NOT NULL,
    present boolean NOT NULL,
    event_id text NOT NULL,
    CONSTRAINT subject_page_dependency_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['subject'::text, 'source-fence'::text]))),
    CONSTRAINT subject_page_dependency_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT subject_page_dependency_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_page_fanout; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_fanout (
    route integer NOT NULL,
    owner_kind text NOT NULL,
    owner_key text NOT NULL,
    change_id text NOT NULL,
    effective_at timestamp with time zone,
    evidence text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    source_key text[] DEFAULT '{}'::text[] NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    worker text,
    lease_until timestamp with time zone,
    CONSTRAINT subject_page_fanout_check CHECK (((evidence = 'known'::text) = (effective_at IS NOT NULL))),
    CONSTRAINT subject_page_fanout_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_fanout_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['subject'::text, 'source-fence'::text]))),
    CONSTRAINT subject_page_fanout_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_page_fanout_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'done'::text])))
);


--
-- Name: subject_page_owner; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_owner (
    route integer NOT NULL,
    owner_kind text NOT NULL,
    owner_key text NOT NULL,
    change_id text NOT NULL,
    effective_at timestamp with time zone,
    evidence text NOT NULL,
    CONSTRAINT subject_page_owner_check CHECK (((evidence = 'known'::text) = (effective_at IS NOT NULL))),
    CONSTRAINT subject_page_owner_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_owner_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['subject'::text, 'source-fence'::text]))),
    CONSTRAINT subject_page_owner_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_page_owner_dependency; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_owner_dependency (
    route integer NOT NULL,
    owner_kind text NOT NULL,
    owner_key text NOT NULL,
    source_route integer NOT NULL,
    source_subject_id uuid NOT NULL,
    component_key text NOT NULL,
    source_version bigint NOT NULL,
    present boolean NOT NULL,
    event_id text NOT NULL,
    effective_at timestamp with time zone,
    evidence text NOT NULL,
    CONSTRAINT subject_page_owner_dependency_check CHECK (((evidence = 'known'::text) = (effective_at IS NOT NULL))),
    CONSTRAINT subject_page_owner_dependency_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_owner_dependency_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['subject'::text, 'source-fence'::text]))),
    CONSTRAINT subject_page_owner_dependency_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_page_owner_dependency_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535)))
);


--
-- Name: subject_page_publication; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_publication (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    readiness text DEFAULT 'cold'::text NOT NULL,
    completed_position bigint DEFAULT 0 NOT NULL,
    change_position bigint DEFAULT 0 NOT NULL,
    public_effective_at timestamp with time zone,
    evidence text DEFAULT 'missing'::text NOT NULL,
    witnesses jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT subject_page_publication_check CHECK (((evidence = 'known'::text) = (public_effective_at IS NOT NULL))),
    CONSTRAINT subject_page_publication_evidence_check CHECK ((evidence = ANY (ARRAY['known'::text, 'missing'::text]))),
    CONSTRAINT subject_page_publication_generation_check CHECK ((generation > 0)),
    CONSTRAINT subject_page_publication_readiness_check CHECK ((readiness = ANY (ARRAY['cold'::text, 'repairing'::text, 'ready'::text]))),
    CONSTRAINT subject_page_publication_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_page_publication_witnesses_check CHECK (semantic.subject_page_valid_witnesses(witnesses))
);


--
-- Name: subject_page_repair; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_repair (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    generation bigint NOT NULL,
    phase text DEFAULT 'descriptive'::text NOT NULL,
    source_key text[] DEFAULT '{}'::text[] NOT NULL,
    high_water bigint DEFAULT 0 NOT NULL,
    replay_position bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    worker text,
    lease_until timestamp with time zone,
    dirty boolean DEFAULT false NOT NULL,
    CONSTRAINT subject_page_repair_phase_check CHECK ((phase = ANY (ARRAY['bootstrap'::text, 'descriptive'::text, 'relations'::text, 'evidence'::text, 'replay'::text, 'done'::text]))),
    CONSTRAINT subject_page_repair_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_page_repair_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'done'::text])))
);


--
-- Name: subject_page_source; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_source (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    owner_route integer NOT NULL,
    owner_key text NOT NULL,
    CONSTRAINT subject_page_source_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT subject_page_source_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_page_work_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject_page_work_home (
    partition_no integer NOT NULL,
    pending integer NOT NULL,
    CONSTRAINT subject_page_work_home_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT subject_page_work_home_pending_check CHECK ((pending >= 0))
);


--
-- Name: acceptance_current acceptance_current_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_pkey PRIMARY KEY (route, subject_id, context_id, candidate_id);


--
-- Name: acceptance acceptance_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_pkey PRIMARY KEY (route, subject_id, context_id, candidate_id, head);


--
-- Name: account_agent_moved_link account_agent_moved_link_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_moved_link
    ADD CONSTRAINT account_agent_moved_link_pkey PRIMARY KEY (route, receipt_id, moved_from, property, source_subject_id, statement_id, filter_value, context_id);


--
-- Name: account_agent_subject account_agent_subject_account_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_subject
    ADD CONSTRAINT account_agent_subject_account_id_key UNIQUE (account_id);


--
-- Name: account_agent_subject account_agent_subject_agent_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_subject
    ADD CONSTRAINT account_agent_subject_agent_id_key UNIQUE (agent_id);


--
-- Name: account_agent_subject account_agent_subject_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_subject
    ADD CONSTRAINT account_agent_subject_pkey PRIMARY KEY (route, subject_id);


--
-- Name: adoption adoption_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.adoption
    ADD CONSTRAINT adoption_pkey PRIMARY KEY (route, subject_id, slot_id, context_id, head);


--
-- Name: candidate candidate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.candidate
    ADD CONSTRAINT candidate_pkey PRIMARY KEY (route, subject_id, candidate_id);


--
-- Name: context_directory_entry context_directory_entry_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_directory_entry
    ADD CONSTRAINT context_directory_entry_pkey PRIMARY KEY (route, context_id, language);


--
-- Name: context_directory_entry context_directory_entry_route_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_directory_entry
    ADD CONSTRAINT context_directory_entry_route_erasure_key_key UNIQUE (route, erasure_key);


--
-- Name: context_directory_home context_directory_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_directory_home
    ADD CONSTRAINT context_directory_home_pkey PRIMARY KEY (route);


--
-- Name: context_directory_home context_directory_home_route_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_directory_home
    ADD CONSTRAINT context_directory_home_route_erasure_key_key UNIQUE (route, erasure_key);


--
-- Name: context_extension_activation context_extension_activation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_extension_activation
    ADD CONSTRAINT context_extension_activation_pkey PRIMARY KEY (route, context_id, head);


--
-- Name: context_extension context_extension_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_extension
    ADD CONSTRAINT context_extension_pkey PRIMARY KEY (route, context_id, digest);


--
-- Name: context context_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context
    ADD CONSTRAINT context_pkey PRIMARY KEY (route, context_id);


--
-- Name: context_role_enrollment context_role_enrollment_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_role_enrollment
    ADD CONSTRAINT context_role_enrollment_pkey PRIMARY KEY (route, occurrence);


--
-- Name: contribution_lifecycle contribution_lifecycle_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.contribution_lifecycle
    ADD CONSTRAINT contribution_lifecycle_pkey PRIMARY KEY (route, subject_id, candidate_id);


--
-- Name: definition_activation definition_activation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_activation
    ADD CONSTRAINT definition_activation_pkey PRIMARY KEY (route, head);


--
-- Name: definition_catalogue_activation definition_catalogue_activation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_activation
    ADD CONSTRAINT definition_catalogue_activation_pkey PRIMARY KEY (route, root_digest);


--
-- Name: definition_catalogue_activation definition_catalogue_activation_route_activation_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_activation
    ADD CONSTRAINT definition_catalogue_activation_route_activation_id_key UNIQUE (route, activation_id);


--
-- Name: definition_catalogue_artifact definition_catalogue_artifact_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_artifact
    ADD CONSTRAINT definition_catalogue_artifact_pkey PRIMARY KEY (route, digest);


--
-- Name: definition_catalogue_build definition_catalogue_build_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_build
    ADD CONSTRAINT definition_catalogue_build_pkey PRIMARY KEY (route, root_digest);


--
-- Name: definition_catalogue_checkpoint definition_catalogue_checkpoint_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_checkpoint
    ADD CONSTRAINT definition_catalogue_checkpoint_pkey PRIMARY KEY (route, root_digest, phase, job_id, "position");


--
-- Name: definition_catalogue_consumer definition_catalogue_consumer_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_consumer
    ADD CONSTRAINT definition_catalogue_consumer_pkey PRIMARY KEY (route, root_digest, id);


--
-- Name: definition_catalogue_consumer definition_catalogue_consumer_route_root_digest_sequence_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_consumer
    ADD CONSTRAINT definition_catalogue_consumer_route_root_digest_sequence_key UNIQUE (route, root_digest, sequence);


--
-- Name: definition_catalogue_enrollment definition_catalogue_enrollme_route_root_digest_closed_gene_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_enrollment
    ADD CONSTRAINT definition_catalogue_enrollme_route_root_digest_closed_gene_key UNIQUE (route, root_digest, closed_generation);


--
-- Name: definition_catalogue_enrollment definition_catalogue_enrollment_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_enrollment
    ADD CONSTRAINT definition_catalogue_enrollment_pkey PRIMARY KEY (route, root_digest);


--
-- Name: definition_catalogue_frontier definition_catalogue_frontier_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_frontier
    ADD CONSTRAINT definition_catalogue_frontier_pkey PRIMARY KEY (route, root_digest, slot);


--
-- Name: definition_catalogue_frontier definition_catalogue_frontier_route_root_digest_consumer_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_frontier
    ADD CONSTRAINT definition_catalogue_frontier_route_root_digest_consumer_id_key UNIQUE (route, root_digest, consumer_id);


--
-- Name: definition_catalogue_head definition_catalogue_head_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_head
    ADD CONSTRAINT definition_catalogue_head_pkey PRIMARY KEY (route);


--
-- Name: definition_catalogue_identity definition_catalogue_identity_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_identity
    ADD CONSTRAINT definition_catalogue_identity_pkey PRIMARY KEY (route, root_digest, identity_key);


--
-- Name: definition_catalogue_kind definition_catalogue_kind_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_kind
    ADD CONSTRAINT definition_catalogue_kind_pkey PRIMARY KEY (route, root_digest, id_key);


--
-- Name: definition_catalogue_kind definition_catalogue_kind_route_root_digest_ordinal_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_kind
    ADD CONSTRAINT definition_catalogue_kind_route_root_digest_ordinal_key UNIQUE (route, root_digest, ordinal);


--
-- Name: definition_catalogue_label definition_catalogue_label_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_label
    ADD CONSTRAINT definition_catalogue_label_pkey PRIMARY KEY (route, root_digest, language_key, label_sort, ordinal);


--
-- Name: definition_catalogue_member definition_catalogue_member_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_member
    ADD CONSTRAINT definition_catalogue_member_pkey PRIMARY KEY (route, root_digest, release_digest, category, id_key);


--
-- Name: definition_catalogue_original definition_catalogue_original_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_original
    ADD CONSTRAINT definition_catalogue_original_pkey PRIMARY KEY (route, original_key);


--
-- Name: definition_catalogue_position definition_catalogue_position_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_position
    ADD CONSTRAINT definition_catalogue_position_pkey PRIMARY KEY (route, root_digest, phase, native_position);


--
-- Name: definition_catalogue_retirement definition_catalogue_retirement_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_retirement
    ADD CONSTRAINT definition_catalogue_retirement_pkey PRIMARY KEY (route, root_digest);


--
-- Name: definition_catalogue_task definition_catalogue_task_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_task
    ADD CONSTRAINT definition_catalogue_task_pkey PRIMARY KEY (route, root_digest, task_id);


--
-- Name: definition_catalogue_ticket definition_catalogue_ticket_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_ticket
    ADD CONSTRAINT definition_catalogue_ticket_pkey PRIMARY KEY (route, original_key, slot);


--
-- Name: definition_catalogue_ticket definition_catalogue_ticket_route_original_key_kind_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_ticket
    ADD CONSTRAINT definition_catalogue_ticket_route_original_key_kind_key UNIQUE (route, original_key, kind);


--
-- Name: definition_release definition_release_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_release
    ADD CONSTRAINT definition_release_pkey PRIMARY KEY (route, digest);


--
-- Name: definition_type_build definition_type_build_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_type_build
    ADD CONSTRAINT definition_type_build_pkey PRIMARY KEY (route, catalogue);


--
-- Name: definition_type_edge definition_type_edge_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_type_edge
    ADD CONSTRAINT definition_type_edge_pkey PRIMARY KEY (route, catalogue, locale, parent_key, chunk);


--
-- Name: definition_type_edge definition_type_edge_route_catalogue_locale_node_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_type_edge
    ADD CONSTRAINT definition_type_edge_route_catalogue_locale_node_key_key UNIQUE (route, catalogue, locale, node_key);


--
-- Name: definition_type_entry definition_type_entry_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_type_entry
    ADD CONSTRAINT definition_type_entry_pkey PRIMARY KEY (route, catalogue, id_key);


--
-- Name: definition_type_property definition_type_property_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_type_property
    ADD CONSTRAINT definition_type_property_pkey PRIMARY KEY (route, release_digest, id_key);


--
-- Name: erasure_copy_role erasure_copy_role_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_copy_role
    ADD CONSTRAINT erasure_copy_role_pkey PRIMARY KEY (partition_no, store, record_key, transaction_id, account_id, role);


--
-- Name: erasure_delivery erasure_delivery_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_delivery
    ADD CONSTRAINT erasure_delivery_pkey PRIMARY KEY (partition_no, source_position);


--
-- Name: erasure_fence erasure_fence_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_fence
    ADD CONSTRAINT erasure_fence_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_home erasure_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_home
    ADD CONSTRAINT erasure_home_pkey PRIMARY KEY (partition_no, account_id);


--
-- Name: erasure_inbox erasure_inbox_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_inbox
    ADD CONSTRAINT erasure_inbox_pkey PRIMARY KEY (route, account_id, source_partition, store, record_key, role, delivery_position);


--
-- Name: erasure_locator erasure_locator_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_locator
    ADD CONSTRAINT erasure_locator_pkey PRIMARY KEY (partition_no, account_id, role, store, record_key);


--
-- Name: erasure_progress erasure_progress_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_progress
    ADD CONSTRAINT erasure_progress_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_provenance erasure_provenance_partition_no_record_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_provenance
    ADD CONSTRAINT erasure_provenance_partition_no_record_key_key UNIQUE (partition_no, record_key);


--
-- Name: erasure_provenance erasure_provenance_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_provenance
    ADD CONSTRAINT erasure_provenance_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: erasure_shared_custody erasure_shared_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_shared_custody
    ADD CONSTRAINT erasure_shared_custody_pkey PRIMARY KEY (partition_no, account_id, role, transaction_id);


--
-- Name: erasure_source_commit erasure_source_commit_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_commit
    ADD CONSTRAINT erasure_source_commit_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: erasure_source_disposition erasure_source_disposition_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_disposition
    ADD CONSTRAINT erasure_source_disposition_pkey PRIMARY KEY (partition_no, store, record_key);


--
-- Name: erasure_source_hold erasure_source_hold_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_hold
    ADD CONSTRAINT erasure_source_hold_pkey PRIMARY KEY (partition_no, id);


--
-- Name: erasure_source_page erasure_source_page_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_page
    ADD CONSTRAINT erasure_source_page_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_source_page erasure_source_page_route_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_page
    ADD CONSTRAINT erasure_source_page_route_id_key UNIQUE (route, id);


--
-- Name: erasure_source_record erasure_source_record_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_record
    ADD CONSTRAINT erasure_source_record_pkey PRIMARY KEY (partition_no, account_id, role, store, record_key, delivery_position, origin_key);


--
-- Name: erasure_source_role erasure_source_role_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_role
    ADD CONSTRAINT erasure_source_role_pkey PRIMARY KEY (partition_no, transaction_id, account_id, role);


--
-- Name: erasure_source_seal erasure_source_seal_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_seal
    ADD CONSTRAINT erasure_source_seal_pkey PRIMARY KEY (partition_no, account_id);


--
-- Name: erasure_source_terminal erasure_source_terminal_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_terminal
    ADD CONSTRAINT erasure_source_terminal_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_source_terminal erasure_source_terminal_route_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_source_terminal
    ADD CONSTRAINT erasure_source_terminal_route_id_key UNIQUE (route, id);


--
-- Name: external_claim external_claim_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.external_claim
    ADD CONSTRAINT external_claim_pkey PRIMARY KEY (route, source, external_id);


--
-- Name: facet_population_frontier facet_population_frontier_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.facet_population_frontier
    ADD CONSTRAINT facet_population_frontier_pkey PRIMARY KEY (partition_no, frontier);


--
-- Name: fact fact_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.fact
    ADD CONSTRAINT fact_pkey PRIMARY KEY (route, subject_id, slot_id, log_seq);


--
-- Name: hidden_candidate hidden_candidate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.hidden_candidate
    ADD CONSTRAINT hidden_candidate_pkey PRIMARY KEY (route, subject_id, candidate_id);


--
-- Name: identity_epoch_ack identity_epoch_ack_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_ack
    ADD CONSTRAINT identity_epoch_ack_pkey PRIMARY KEY (partition_no, job_id, step);


--
-- Name: identity_epoch_admission_attempt identity_epoch_admission_attempt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_attempt
    ADD CONSTRAINT identity_epoch_admission_attempt_pkey PRIMARY KEY (partition_no, job_id);


--
-- Name: identity_epoch_admission_handoff identity_epoch_admission_handoff_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_handoff
    ADD CONSTRAINT identity_epoch_admission_handoff_pkey PRIMARY KEY (partition_no, job_id);


--
-- Name: identity_epoch_admission_plan identity_epoch_admission_plan_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_plan
    ADD CONSTRAINT identity_epoch_admission_plan_pkey PRIMARY KEY (partition_no, job_id, resource_home);


--
-- Name: identity_epoch_admission_receipt identity_epoch_admission_receipt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_receipt
    ADD CONSTRAINT identity_epoch_admission_receipt_pkey PRIMARY KEY (partition_no, job_id, stage);


--
-- Name: identity_epoch_admission_source_hold identity_epoch_admission_source_hold_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_source_hold
    ADD CONSTRAINT identity_epoch_admission_source_hold_pkey PRIMARY KEY (partition_no, job_id, original);


--
-- Name: identity_epoch_admission_source identity_epoch_admission_source_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_source
    ADD CONSTRAINT identity_epoch_admission_source_pkey PRIMARY KEY (partition_no, job_id, original);


--
-- Name: identity_epoch_admission_validation identity_epoch_admission_validation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_validation
    ADD CONSTRAINT identity_epoch_admission_validation_pkey PRIMARY KEY (partition_no, job_id, original);


--
-- Name: identity_epoch_bootstrap_basis identity_epoch_bootstrap_basis_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_basis
    ADD CONSTRAINT identity_epoch_bootstrap_basis_pkey PRIMARY KEY (partition_no, source_partition, source_generation);


--
-- Name: identity_epoch_bootstrap_custody identity_epoch_bootstrap_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_custody
    ADD CONSTRAINT identity_epoch_bootstrap_custody_pkey PRIMARY KEY (partition_no, source_partition, source_generation, stage);


--
-- Name: identity_epoch_bootstrap_home identity_epoch_bootstrap_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_home
    ADD CONSTRAINT identity_epoch_bootstrap_home_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_bootstrap_page identity_epoch_bootstrap_page_partition_no_generation_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_page
    ADD CONSTRAINT identity_epoch_bootstrap_page_partition_no_generation_key UNIQUE (partition_no, generation);


--
-- Name: identity_epoch_bootstrap_page identity_epoch_bootstrap_page_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_page
    ADD CONSTRAINT identity_epoch_bootstrap_page_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: identity_epoch_bootstrap_row identity_epoch_bootstrap_row_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_row
    ADD CONSTRAINT identity_epoch_bootstrap_row_pkey PRIMARY KEY (partition_no, transaction_id, original, terminal);


--
-- Name: identity_epoch_bootstrap_topology_home identity_epoch_bootstrap_topology_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_topology_home
    ADD CONSTRAINT identity_epoch_bootstrap_topology_home_pkey PRIMARY KEY (partition_no, source_partition);


--
-- Name: identity_epoch_bootstrap_topology identity_epoch_bootstrap_topology_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_topology
    ADD CONSTRAINT identity_epoch_bootstrap_topology_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_change identity_epoch_change_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_change
    ADD CONSTRAINT identity_epoch_change_pkey PRIMARY KEY (partition_no, job_id, original);


--
-- Name: identity_epoch_control identity_epoch_control_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_control
    ADD CONSTRAINT identity_epoch_control_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_dirty identity_epoch_dirty_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_dirty
    ADD CONSTRAINT identity_epoch_dirty_pkey PRIMARY KEY (route, original);


--
-- Name: identity_epoch_effect_receipt identity_epoch_effect_receipt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_effect_receipt
    ADD CONSTRAINT identity_epoch_effect_receipt_pkey PRIMARY KEY (partition_no, job_id, step, effect_key);


--
-- Name: identity_epoch_group identity_epoch_group_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_group
    ADD CONSTRAINT identity_epoch_group_pkey PRIMARY KEY (partition_no, terminal);


--
-- Name: identity_epoch_home_gate identity_epoch_home_gate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_home_gate
    ADD CONSTRAINT identity_epoch_home_gate_pkey PRIMARY KEY (route, destination, original);


--
-- Name: identity_epoch_input identity_epoch_input_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_input
    ADD CONSTRAINT identity_epoch_input_pkey PRIMARY KEY (partition_no, job_id, terminal);


--
-- Name: identity_epoch_installation_cut identity_epoch_installation_cut_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_installation_cut
    ADD CONSTRAINT identity_epoch_installation_cut_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_installation identity_epoch_installation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_installation
    ADD CONSTRAINT identity_epoch_installation_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_job identity_epoch_job_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_job
    ADD CONSTRAINT identity_epoch_job_pkey PRIMARY KEY (partition_no, job_id);


--
-- Name: identity_epoch_legacy_member identity_epoch_legacy_member_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_legacy_member
    ADD CONSTRAINT identity_epoch_legacy_member_pkey PRIMARY KEY (partition_no, terminal, original);


--
-- Name: identity_epoch_mapping_effect identity_epoch_mapping_effect_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_effect
    ADD CONSTRAINT identity_epoch_mapping_effect_pkey PRIMARY KEY (partition_no, job_id, unit);


--
-- Name: identity_epoch_mapping_fence identity_epoch_mapping_fence_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_fence
    ADD CONSTRAINT identity_epoch_mapping_fence_pkey PRIMARY KEY (route, destination);


--
-- Name: identity_epoch_mapping_generation identity_epoch_mapping_generation_partition_no_generation_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_generation
    ADD CONSTRAINT identity_epoch_mapping_generation_partition_no_generation_key UNIQUE (partition_no, generation);


--
-- Name: identity_epoch_mapping_generation identity_epoch_mapping_generation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_generation
    ADD CONSTRAINT identity_epoch_mapping_generation_pkey PRIMARY KEY (partition_no, slot);


--
-- Name: identity_epoch_mapping_head identity_epoch_mapping_head_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_head
    ADD CONSTRAINT identity_epoch_mapping_head_pkey PRIMARY KEY (partition_no, job_id);


--
-- Name: identity_epoch_mapping_payload identity_epoch_mapping_payload_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_payload
    ADD CONSTRAINT identity_epoch_mapping_payload_pkey PRIMARY KEY (partition_no, job_id, unit);


--
-- Name: identity_epoch_mapping identity_epoch_mapping_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping
    ADD CONSTRAINT identity_epoch_mapping_pkey PRIMARY KEY (route, original);


--
-- Name: identity_epoch_mapping_plan identity_epoch_mapping_plan_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_plan
    ADD CONSTRAINT identity_epoch_mapping_plan_pkey PRIMARY KEY (partition_no, job_id, unit);


--
-- Name: identity_epoch_mapping_undo identity_epoch_mapping_undo_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_undo
    ADD CONSTRAINT identity_epoch_mapping_undo_pkey PRIMARY KEY (partition_no, job_id, original);


--
-- Name: identity_epoch_mapping_withdrawal identity_epoch_mapping_withdrawal_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_withdrawal
    ADD CONSTRAINT identity_epoch_mapping_withdrawal_pkey PRIMARY KEY (partition_no, job_id, original, property, target, statement, filter, context);


--
-- Name: identity_epoch_member_dirty identity_epoch_member_dirty_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_member_dirty
    ADD CONSTRAINT identity_epoch_member_dirty_pkey PRIMARY KEY (route, terminal, original);


--
-- Name: identity_epoch_native_commit identity_epoch_native_commit_partition_no_transaction_id_ep_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_native_commit
    ADD CONSTRAINT identity_epoch_native_commit_partition_no_transaction_id_ep_key UNIQUE (partition_no, transaction_id, epoch, "position");


--
-- Name: identity_epoch_native_commit identity_epoch_native_commit_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_native_commit
    ADD CONSTRAINT identity_epoch_native_commit_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: identity_epoch_original identity_epoch_original_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_original
    ADD CONSTRAINT identity_epoch_original_pkey PRIMARY KEY (partition_no, generation, original);


--
-- Name: identity_epoch_prearm_bridge identity_epoch_prearm_bridge_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_bridge
    ADD CONSTRAINT identity_epoch_prearm_bridge_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_bridge identity_epoch_prearm_bridge_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_bridge
    ADD CONSTRAINT identity_epoch_prearm_bridge_pkey PRIMARY KEY (partition_no, generation);


--
-- Name: identity_epoch_prearm_claim identity_epoch_prearm_claim_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_claim
    ADD CONSTRAINT identity_epoch_prearm_claim_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_claim identity_epoch_prearm_claim_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_claim
    ADD CONSTRAINT identity_epoch_prearm_claim_pkey PRIMARY KEY (partition_no, job_id);


--
-- Name: identity_epoch_prearm_custody identity_epoch_prearm_custody_partition_no_directory_partit_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_custody
    ADD CONSTRAINT identity_epoch_prearm_custody_partition_no_directory_partit_key UNIQUE (partition_no, directory_partition, page_id);


--
-- Name: identity_epoch_prearm_custody identity_epoch_prearm_custody_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_custody
    ADD CONSTRAINT identity_epoch_prearm_custody_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_custody identity_epoch_prearm_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_custody
    ADD CONSTRAINT identity_epoch_prearm_custody_pkey PRIMARY KEY (partition_no, job_id, generation, sequence);


--
-- Name: identity_epoch_prearm_decision identity_epoch_prearm_decision_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_decision
    ADD CONSTRAINT identity_epoch_prearm_decision_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_decision identity_epoch_prearm_decision_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_decision
    ADD CONSTRAINT identity_epoch_prearm_decision_pkey PRIMARY KEY (partition_no, job_id, stage);


--
-- Name: identity_epoch_prearm_directory identity_epoch_prearm_directory_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_directory
    ADD CONSTRAINT identity_epoch_prearm_directory_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_directory identity_epoch_prearm_directory_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_directory
    ADD CONSTRAINT identity_epoch_prearm_directory_pkey PRIMARY KEY (partition_no, job_id, generation);


--
-- Name: identity_epoch_prearm_disposition identity_epoch_prearm_disposition_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_disposition
    ADD CONSTRAINT identity_epoch_prearm_disposition_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_disposition identity_epoch_prearm_disposition_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_disposition
    ADD CONSTRAINT identity_epoch_prearm_disposition_pkey PRIMARY KEY (partition_no, page_id, stage);


--
-- Name: identity_epoch_prearm_inverse identity_epoch_prearm_inverse_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_inverse
    ADD CONSTRAINT identity_epoch_prearm_inverse_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_inverse identity_epoch_prearm_inverse_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_inverse
    ADD CONSTRAINT identity_epoch_prearm_inverse_pkey PRIMARY KEY (partition_no, generation, original, scope_key, registration);


--
-- Name: identity_epoch_prearm_page identity_epoch_prearm_page_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_page
    ADD CONSTRAINT identity_epoch_prearm_page_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_prearm_page identity_epoch_prearm_page_partition_no_page_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_page
    ADD CONSTRAINT identity_epoch_prearm_page_partition_no_page_id_key UNIQUE (partition_no, page_id);


--
-- Name: identity_epoch_prearm_page identity_epoch_prearm_page_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_page
    ADD CONSTRAINT identity_epoch_prearm_page_pkey PRIMARY KEY (partition_no, job_id, generation, sequence);


--
-- Name: identity_epoch_receipt_binding identity_epoch_receipt_binding_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_binding
    ADD CONSTRAINT identity_epoch_receipt_binding_pkey PRIMARY KEY (partition_no, receipt_key);


--
-- Name: identity_epoch_receipt_claim_commit identity_epoch_receipt_claim_commit_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_claim_commit
    ADD CONSTRAINT identity_epoch_receipt_claim_commit_pkey PRIMARY KEY (partition_no, receipt_key, generation);


--
-- Name: identity_epoch_receipt_claim identity_epoch_receipt_claim_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_claim
    ADD CONSTRAINT identity_epoch_receipt_claim_pkey PRIMARY KEY (partition_no, receipt_key, generation);


--
-- Name: identity_epoch_receipt_closure identity_epoch_receipt_closure_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_closure
    ADD CONSTRAINT identity_epoch_receipt_closure_pkey PRIMARY KEY (partition_no, receipt_key, generation, resource_home);


--
-- Name: identity_epoch_receiving_custody identity_epoch_receiving_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_custody
    ADD CONSTRAINT identity_epoch_receiving_custody_pkey PRIMARY KEY (partition_no, job_id, effect_key);


--
-- Name: identity_epoch_receiving_effect identity_epoch_receiving_effect_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_effect
    ADD CONSTRAINT identity_epoch_receiving_effect_pkey PRIMARY KEY (partition_no, job_id, effect_key);


--
-- Name: identity_epoch_receiving_gate identity_epoch_receiving_gate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_gate
    ADD CONSTRAINT identity_epoch_receiving_gate_pkey PRIMARY KEY (partition_no, owner_id, original);


--
-- Name: identity_epoch_receiving_plan identity_epoch_receiving_plan_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_plan
    ADD CONSTRAINT identity_epoch_receiving_plan_pkey PRIMARY KEY (partition_no, job_id, effect_key);


--
-- Name: identity_epoch_receiving_record identity_epoch_receiving_record_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_record
    ADD CONSTRAINT identity_epoch_receiving_record_pkey PRIMARY KEY (partition_no, job_id, effect_key);


--
-- Name: identity_epoch_receiving_search_progress identity_epoch_receiving_search_progress_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_search_progress
    ADD CONSTRAINT identity_epoch_receiving_search_progress_pkey PRIMARY KEY (partition_no, job_id, effect_key);


--
-- Name: identity_epoch_source_consumer_custody identity_epoch_source_consumer_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_custody
    ADD CONSTRAINT identity_epoch_source_consumer_custody_pkey PRIMARY KEY (partition_no, receipt_key, source_digest, barrier_account_id, barrier_version, barrier_at, erased_role, binding_generation);


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consumer_ter_partition_no_erasure_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_terminal
    ADD CONSTRAINT identity_epoch_source_consumer_ter_partition_no_erasure_key_key UNIQUE (partition_no, erasure_key);


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consumer_terminal_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_terminal
    ADD CONSTRAINT identity_epoch_source_consumer_terminal_pkey PRIMARY KEY (partition_no, custody_key, sequence);


--
-- Name: identity_epoch_step identity_epoch_step_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_step
    ADD CONSTRAINT identity_epoch_step_pkey PRIMARY KEY (partition_no, transaction_id, job_id, step);


--
-- Name: identity_epoch_topology_custody identity_epoch_topology_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_topology_custody
    ADD CONSTRAINT identity_epoch_topology_custody_pkey PRIMARY KEY (partition_no, source_partition);


--
-- Name: identity_public_capture_home identity_public_capture_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_capture_home
    ADD CONSTRAINT identity_public_capture_home_pkey PRIMARY KEY (partition_no, capture_id, home);


--
-- Name: identity_public_capture_key identity_public_capture_key_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_capture_key
    ADD CONSTRAINT identity_public_capture_key_pkey PRIMARY KEY (partition_no, capture_id, original);


--
-- Name: identity_public_capture_page identity_public_capture_page_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_capture_page
    ADD CONSTRAINT identity_public_capture_page_pkey PRIMARY KEY (partition_no, capture_id, page_version);


--
-- Name: identity_public_capture identity_public_capture_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_capture
    ADD CONSTRAINT identity_public_capture_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_dirty identity_public_dirty_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_dirty
    ADD CONSTRAINT identity_public_dirty_pkey PRIMARY KEY (partition_no, original);


--
-- Name: identity_public_output_accepted identity_public_output_accepted_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_accepted
    ADD CONSTRAINT identity_public_output_accepted_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_output_consumer identity_public_output_consumer_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_consumer
    ADD CONSTRAINT identity_public_output_consumer_pkey PRIMARY KEY (partition_no, capture_id, consumer_id);


--
-- Name: identity_public_output_disposition identity_public_output_disposition_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_disposition
    ADD CONSTRAINT identity_public_output_disposition_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_output_fence identity_public_output_fence_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_fence
    ADD CONSTRAINT identity_public_output_fence_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_output_gate identity_public_output_gate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_gate
    ADD CONSTRAINT identity_public_output_gate_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_output_member identity_public_output_member_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_member
    ADD CONSTRAINT identity_public_output_member_pkey PRIMARY KEY (partition_no, capture_id, terminal);


--
-- Name: identity_public_output_original identity_public_output_original_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_original
    ADD CONSTRAINT identity_public_output_original_pkey PRIMARY KEY (partition_no, capture_id, original);


--
-- Name: identity_public_output_page identity_public_output_page_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_page
    ADD CONSTRAINT identity_public_output_page_pkey PRIMARY KEY (partition_no, capture_id, version);


--
-- Name: identity_public_output_progress identity_public_output_progress_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_progress
    ADD CONSTRAINT identity_public_output_progress_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_output_seal identity_public_output_seal_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_seal
    ADD CONSTRAINT identity_public_output_seal_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_output_stage identity_public_output_stage_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_stage
    ADD CONSTRAINT identity_public_output_stage_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_output_subject_cut identity_public_output_subject_cut_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_subject_cut
    ADD CONSTRAINT identity_public_output_subject_cut_pkey PRIMARY KEY (partition_no, capture_partition, capture_id, original);


--
-- Name: identity_public_output_subject_release identity_public_output_subject_release_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_subject_release
    ADD CONSTRAINT identity_public_output_subject_release_pkey PRIMARY KEY (partition_no, capture_partition, capture_id, original);


--
-- Name: identity_public_output_subject_slot identity_public_output_subject_slot_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_subject_slot
    ADD CONSTRAINT identity_public_output_subject_slot_pkey PRIMARY KEY (partition_no, capture_partition, capture_id, original);


--
-- Name: identity_public_output_transition identity_public_output_transition_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_transition
    ADD CONSTRAINT identity_public_output_transition_pkey PRIMARY KEY (partition_no, capture_id);


--
-- Name: identity_public_writer identity_public_writer_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_writer
    ADD CONSTRAINT identity_public_writer_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_receiving_capture_pending identity_receiving_capture_pending_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_receiving_capture_pending
    ADD CONSTRAINT identity_receiving_capture_pending_pkey PRIMARY KEY (transaction_xid, ordinal);


--
-- Name: identity_scope_attempt identity_scope_attempt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_attempt
    ADD CONSTRAINT identity_scope_attempt_pkey PRIMARY KEY (partition_no, source_key, scope_id, registration, job_id, job_epoch);


--
-- Name: identity_scope_bridge identity_scope_bridge_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_bridge
    ADD CONSTRAINT identity_scope_bridge_pkey PRIMARY KEY (partition_no, generation);


--
-- Name: identity_scope_completion identity_scope_completion_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_completion
    ADD CONSTRAINT identity_scope_completion_pkey PRIMARY KEY (partition_no, source_key, scope_id, registration, job_id, job_epoch);


--
-- Name: identity_scope_consumer_fence identity_scope_consumer_fence_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_consumer_fence
    ADD CONSTRAINT identity_scope_consumer_fence_pkey PRIMARY KEY (partition_no, source_key, scope_id, registration, job_id, job_epoch);


--
-- Name: identity_scope_directory_release identity_scope_directory_release_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_directory_release
    ADD CONSTRAINT identity_scope_directory_release_pkey PRIMARY KEY (partition_no, generation, original, source_partition, source_key, scope_id, registration);


--
-- Name: identity_scope_forward identity_scope_forward_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_forward
    ADD CONSTRAINT identity_scope_forward_pkey PRIMARY KEY (partition_no, source_key, scope_id, registration, dependency);


--
-- Name: identity_scope_inverse identity_scope_inverse_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_inverse
    ADD CONSTRAINT identity_scope_inverse_pkey PRIMARY KEY (partition_no, generation, original, source_partition, source_key, scope_id, registration);


--
-- Name: identity_scope_native_association identity_scope_native_association_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_native_association
    ADD CONSTRAINT identity_scope_native_association_pkey PRIMARY KEY (partition_no, source_key, scope_id, registration, capture_id, revision, phase);


--
-- Name: identity_scope_prearm_receipt identity_scope_prearm_receipt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_prearm_receipt
    ADD CONSTRAINT identity_scope_prearm_receipt_pkey PRIMARY KEY (partition_no, source_key, scope_id, registration, job_id, job_epoch, directory_transaction, page_id, ordinal, disposition);


--
-- Name: identity_scope_repair_cursor identity_scope_repair_cursor_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_repair_cursor
    ADD CONSTRAINT identity_scope_repair_cursor_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_scope_summary identity_scope_summary_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_summary
    ADD CONSTRAINT identity_scope_summary_pkey PRIMARY KEY (partition_no, source_key, scope_id);


--
-- Name: inbound_link_context_count inbound_link_context_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.inbound_link_context_count
    ADD CONSTRAINT inbound_link_context_count_pkey PRIMARY KEY (route, subject_id, context_id, property, filter_value);


--
-- Name: inbound_link_count inbound_link_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.inbound_link_count
    ADD CONSTRAINT inbound_link_count_pkey PRIMARY KEY (route, subject_id, property, filter_value);


--
-- Name: inbound_link inbound_link_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.inbound_link
    ADD CONSTRAINT inbound_link_pkey PRIMARY KEY (route, subject_id, context_id, property, source_subject_id, statement_id, filter_value);


--
-- Name: kind_type_anchor_fence kind_type_anchor_fence_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.kind_type_anchor_fence
    ADD CONSTRAINT kind_type_anchor_fence_pkey PRIMARY KEY (route, subject_id);


--
-- Name: kind_type_evidence_body kind_type_evidence_body_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.kind_type_evidence_body
    ADD CONSTRAINT kind_type_evidence_body_pkey PRIMARY KEY (route, owner_account_id, collection_id, preparation_id, evidence_id);


--
-- Name: merge_member merge_member_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.merge_member
    ADD CONSTRAINT merge_member_pkey PRIMARY KEY (route, subject_id, member_id);


--
-- Name: moderation moderation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.moderation
    ADD CONSTRAINT moderation_pkey PRIMARY KEY (route, subject_id, security_revision);


--
-- Name: outbound_link_context_count outbound_link_context_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.outbound_link_context_count
    ADD CONSTRAINT outbound_link_context_count_pkey PRIMARY KEY (route, subject_id, context_id, property, filter_value);


--
-- Name: outbound_link_count outbound_link_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.outbound_link_count
    ADD CONSTRAINT outbound_link_count_pkey PRIMARY KEY (route, subject_id, property, filter_value);


--
-- Name: outbound_link outbound_link_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.outbound_link
    ADD CONSTRAINT outbound_link_pkey PRIMARY KEY (route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id);


--
-- Name: partition_subjects partition_subjects_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.partition_subjects
    ADD CONSTRAINT partition_subjects_pkey PRIMARY KEY (partition_no);


--
-- Name: provider_review_queue_bootstrap provider_review_queue_bootstrap_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.provider_review_queue_bootstrap
    ADD CONSTRAINT provider_review_queue_bootstrap_pkey PRIMARY KEY (partition_no, source);


--
-- Name: provider_review_queue_entry provider_review_queue_entry_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.provider_review_queue_entry
    ADD CONSTRAINT provider_review_queue_entry_pkey PRIMARY KEY (route, source, subject_id, candidate_id);


--
-- Name: provider_review_queue_key provider_review_queue_key_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.provider_review_queue_key
    ADD CONSTRAINT provider_review_queue_key_pkey PRIMARY KEY (route, source, subject_id, candidate_id);


--
-- Name: provider_review_queue_ready provider_review_queue_ready_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.provider_review_queue_ready
    ADD CONSTRAINT provider_review_queue_ready_pkey PRIMARY KEY (route, source, source_partition);


--
-- Name: public_filter_bootstrap_account public_filter_bootstrap_account_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_bootstrap_account
    ADD CONSTRAINT public_filter_bootstrap_account_pkey PRIMARY KEY (partition_no, bootstrap, account_partition);


--
-- Name: public_filter_bootstrap public_filter_bootstrap_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_bootstrap
    ADD CONSTRAINT public_filter_bootstrap_pkey PRIMARY KEY (partition_no, bootstrap);


--
-- Name: public_filter_home_enrollment public_filter_home_enrollment_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_home_enrollment
    ADD CONSTRAINT public_filter_home_enrollment_pkey PRIMARY KEY (partition_no, bootstrap);


--
-- Name: public_filter_key_enrollment public_filter_key_enrollment_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_key_enrollment
    ADD CONSTRAINT public_filter_key_enrollment_pkey PRIMARY KEY (partition_no, input_key, registration_partition, registration, bootstrap);


--
-- Name: public_filter_population_start public_filter_population_start_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_population_start
    ADD CONSTRAINT public_filter_population_start_pkey PRIMARY KEY (partition_no, id);


--
-- Name: public_filter_privacy_head public_filter_privacy_head_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_head
    ADD CONSTRAINT public_filter_privacy_head_pkey PRIMARY KEY (partition_no);


--
-- Name: public_filter_privacy_log public_filter_privacy_log_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_log
    ADD CONSTRAINT public_filter_privacy_log_pkey PRIMARY KEY (partition_no, "position");


--
-- Name: public_filter_privacy_log public_filter_privacy_log_tx_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_log
    ADD CONSTRAINT public_filter_privacy_log_tx_key UNIQUE (partition_no, transaction_id);


--
-- Name: public_filter_privacy_pending public_filter_privacy_pending_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_pending
    ADD CONSTRAINT public_filter_privacy_pending_pkey PRIMARY KEY (partition_no, input_key);


--
-- Name: public_filter_privacy_subject public_filter_privacy_subject_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_subject
    ADD CONSTRAINT public_filter_privacy_subject_pkey PRIMARY KEY (partition_no, subject_id);


--
-- Name: public_filter_projection_build public_filter_projection_build_build_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_build
    ADD CONSTRAINT public_filter_projection_build_build_id_key UNIQUE (build_id);


--
-- Name: public_filter_projection_build public_filter_projection_build_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_build
    ADD CONSTRAINT public_filter_projection_build_pkey PRIMARY KEY (partition_no, subject_id);


--
-- Name: public_filter_projection_head public_filter_projection_head_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_head
    ADD CONSTRAINT public_filter_projection_head_pkey PRIMARY KEY (build_id, partition_no);


--
-- Name: public_filter_projection_replay public_filter_projection_replay_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_replay
    ADD CONSTRAINT public_filter_projection_replay_pkey PRIMARY KEY (partition_no, bootstrap, execution, predecessor, route, subject_id, request_digest);


--
-- Name: public_filter_read_definition public_filter_read_definition_partition_no_source_id_config_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_read_definition
    ADD CONSTRAINT public_filter_read_definition_partition_no_source_id_config_key UNIQUE (partition_no, source_id, configuration, release_digest, subject_type, capture_digest);


--
-- Name: public_filter_read_definition public_filter_read_definition_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_read_definition
    ADD CONSTRAINT public_filter_read_definition_pkey PRIMARY KEY (partition_no, read_definition);


--
-- Name: public_filter_repair_advance public_filter_repair_advance_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_repair_advance
    ADD CONSTRAINT public_filter_repair_advance_pkey PRIMARY KEY (partition_no, bootstrap, execution, step, route, subject_id);


--
-- Name: public_filter_repair_step public_filter_repair_step_partition_no_bootstrap_execution__key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_repair_step
    ADD CONSTRAINT public_filter_repair_step_partition_no_bootstrap_execution__key UNIQUE (partition_no, bootstrap, execution, predecessor);


--
-- Name: public_filter_repair_step public_filter_repair_step_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_repair_step
    ADD CONSTRAINT public_filter_repair_step_pkey PRIMARY KEY (partition_no, bootstrap, execution, step);


--
-- Name: public_filter_source public_filter_source_partition_no_route_digest_owner_epoch__key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_source
    ADD CONSTRAINT public_filter_source_partition_no_route_digest_owner_epoch__key UNIQUE (partition_no, route_digest, owner_epoch, family);


--
-- Name: public_filter_source public_filter_source_partition_no_source_id_configuration_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_source
    ADD CONSTRAINT public_filter_source_partition_no_source_id_configuration_key UNIQUE (partition_no, source_id, configuration);


--
-- Name: public_filter_source public_filter_source_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_source
    ADD CONSTRAINT public_filter_source_pkey PRIMARY KEY (partition_no, source_id);


--
-- Name: record_lifecycle record_lifecycle_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_lifecycle
    ADD CONSTRAINT record_lifecycle_pkey PRIMARY KEY (route, subject_id, candidate_id);


--
-- Name: record_purge_command record_purge_command_partition_no_source_key_transaction_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_command
    ADD CONSTRAINT record_purge_command_partition_no_source_key_transaction_id_key UNIQUE (partition_no, source_key, transaction_id);


--
-- Name: record_purge_command record_purge_command_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_command
    ADD CONSTRAINT record_purge_command_pkey PRIMARY KEY (partition_no, source_key, key);


--
-- Name: record_purge_hold record_purge_hold_hold_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_hold
    ADD CONSTRAINT record_purge_hold_hold_id_key UNIQUE (hold_id);


--
-- Name: record_purge_hold record_purge_hold_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_hold
    ADD CONSTRAINT record_purge_hold_pkey PRIMARY KEY (partition_no, source_key, deletion_generation, receiving_partition, receiving_id);


--
-- Name: record_purge_receiving record_purge_receiving_partition_no_hold_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_receiving
    ADD CONSTRAINT record_purge_receiving_partition_no_hold_id_key UNIQUE (partition_no, hold_id);


--
-- Name: record_purge_receiving record_purge_receiving_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_receiving
    ADD CONSTRAINT record_purge_receiving_pkey PRIMARY KEY (partition_no, receiving_id, source_key, deletion_generation);


--
-- Name: record_purge_writer record_purge_writer_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_writer
    ADD CONSTRAINT record_purge_writer_pkey PRIMARY KEY (partition_no, source_key);


--
-- Name: record_purge_writer record_purge_writer_route_kind_resource_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_writer
    ADD CONSTRAINT record_purge_writer_route_kind_resource_id_key UNIQUE (route, kind, resource_id);


--
-- Name: record_retention_commit record_retention_commit_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_commit
    ADD CONSTRAINT record_retention_commit_pkey PRIMARY KEY (route, subject_id, candidate_id, deletion_generation);


--
-- Name: record_retention_document record_retention_document_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_document
    ADD CONSTRAINT record_retention_document_pkey PRIMARY KEY (route, subject_id, candidate_id, deletion_generation, document_id);


--
-- Name: record_retention_home record_retention_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_home
    ADD CONSTRAINT record_retention_home_pkey PRIMARY KEY (partition_no);


--
-- Name: record_retention_key record_retention_key_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_key
    ADD CONSTRAINT record_retention_key_pkey PRIMARY KEY (partition_no, key);


--
-- Name: record_retention_key record_retention_key_route_kind_owner_id_record_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_key
    ADD CONSTRAINT record_retention_key_route_kind_owner_id_record_id_key UNIQUE (route, kind, owner_id, record_id);


--
-- Name: record_retention_page record_retention_page_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_page
    ADD CONSTRAINT record_retention_page_pkey PRIMARY KEY (partition_no, key);


--
-- Name: record_retention_schedule record_retention_schedule_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_schedule
    ADD CONSTRAINT record_retention_schedule_pkey PRIMARY KEY (partition_no);


--
-- Name: record_source_set_member record_source_set_member_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_source_set_member
    ADD CONSTRAINT record_source_set_member_pkey PRIMARY KEY (partition_no, transaction_id, source_hash);


--
-- Name: record_source_set record_source_set_partition_no_transaction_id_revision_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_source_set
    ADD CONSTRAINT record_source_set_partition_no_transaction_id_revision_key UNIQUE (partition_no, transaction_id, revision);


--
-- Name: record_source_set record_source_set_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_source_set
    ADD CONSTRAINT record_source_set_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: redirect redirect_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.redirect
    ADD CONSTRAINT redirect_pkey PRIMARY KEY (route, subject_id, sequence);


--
-- Name: relation_context_slot relation_context_slot_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.relation_context_slot
    ADD CONSTRAINT relation_context_slot_pkey PRIMARY KEY (route, subject_id, slot_id, context_id);


--
-- Name: release_composite release_composite_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.release_composite
    ADD CONSTRAINT release_composite_pkey PRIMARY KEY (digest);


--
-- Name: resource_record_purge_commit resource_record_purge_commit_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.resource_record_purge_commit
    ADD CONSTRAINT resource_record_purge_commit_pkey PRIMARY KEY (route, kind, resource_id, deletion_generation);


--
-- Name: retraction retraction_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.retraction
    ADD CONSTRAINT retraction_pkey PRIMARY KEY (route, subject_id, candidate_id, revision);


--
-- Name: revision revision_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.revision
    ADD CONSTRAINT revision_pkey PRIMARY KEY (route, subject_id, revision);


--
-- Name: search_relation_probe search_relation_probe_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_relation_probe
    ADD CONSTRAINT search_relation_probe_pkey PRIMARY KEY (route, subject_id, property, value);


--
-- Name: search_selected search_selected_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selected
    ADD CONSTRAINT search_selected_pkey PRIMARY KEY (route, subject_id, slot_id, candidate_id);


--
-- Name: search_selection_retraction search_selection_retraction_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selection_retraction
    ADD CONSTRAINT search_selection_retraction_pkey PRIMARY KEY (route, subject_id, slot_id, candidate_id);


--
-- Name: search_selection_slot search_selection_slot_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selection_slot
    ADD CONSTRAINT search_selection_slot_pkey PRIMARY KEY (route, subject_id, slot_id);


--
-- Name: search_selection_state search_selection_state_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selection_state
    ADD CONSTRAINT search_selection_state_pkey PRIMARY KEY (route, subject_id);


--
-- Name: source_candidate source_candidate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.source_candidate
    ADD CONSTRAINT source_candidate_pkey PRIMARY KEY (route, subject_id, source, external_id, field_group, statement_digest);


--
-- Name: source_record source_record_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.source_record
    ADD CONSTRAINT source_record_pkey PRIMARY KEY (route, source, external_id);


--
-- Name: statement_disclosure statement_disclosure_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.statement_disclosure
    ADD CONSTRAINT statement_disclosure_pkey PRIMARY KEY (route, candidate_id);


--
-- Name: subject_page_bootstrap subject_page_bootstrap_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_bootstrap
    ADD CONSTRAINT subject_page_bootstrap_pkey PRIMARY KEY (partition_no);


--
-- Name: subject_page_change subject_page_change_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_change
    ADD CONSTRAINT subject_page_change_pkey PRIMARY KEY (route, subject_id, "position");


--
-- Name: subject_page_change subject_page_change_route_subject_id_change_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_change
    ADD CONSTRAINT subject_page_change_route_subject_id_change_id_key UNIQUE (route, subject_id, change_id);


--
-- Name: subject_page_component subject_page_component_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_component
    ADD CONSTRAINT subject_page_component_pkey PRIMARY KEY (route, subject_id, component_kind, component_key);


--
-- Name: subject_page_continuation subject_page_continuation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_continuation
    ADD CONSTRAINT subject_page_continuation_pkey PRIMARY KEY (route, subject_id, kind);


--
-- Name: subject_page_delivery subject_page_delivery_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_delivery
    ADD CONSTRAINT subject_page_delivery_pkey PRIMARY KEY (route, subject_id, owner_kind, owner_route, owner_key, change_id, event_id);


--
-- Name: subject_page_dependency subject_page_dependency_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_dependency
    ADD CONSTRAINT subject_page_dependency_pkey PRIMARY KEY (route, subject_id, owner_kind, owner_route, owner_key, component_key);


--
-- Name: subject_page_fanout subject_page_fanout_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_fanout
    ADD CONSTRAINT subject_page_fanout_pkey PRIMARY KEY (route, owner_kind, owner_key, change_id);


--
-- Name: subject_page_owner_dependency subject_page_owner_dependency_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_owner_dependency
    ADD CONSTRAINT subject_page_owner_dependency_pkey PRIMARY KEY (route, owner_kind, owner_key, source_route, source_subject_id, component_key);


--
-- Name: subject_page_owner subject_page_owner_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_owner
    ADD CONSTRAINT subject_page_owner_pkey PRIMARY KEY (route, owner_kind, owner_key);


--
-- Name: subject_page_publication subject_page_publication_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_publication
    ADD CONSTRAINT subject_page_publication_pkey PRIMARY KEY (route, subject_id);


--
-- Name: subject_page_repair subject_page_repair_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_repair
    ADD CONSTRAINT subject_page_repair_pkey PRIMARY KEY (route, subject_id);


--
-- Name: subject_page_source subject_page_source_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_source
    ADD CONSTRAINT subject_page_source_pkey PRIMARY KEY (route, subject_id, candidate_id);


--
-- Name: subject_page_work_home subject_page_work_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject_page_work_home
    ADD CONSTRAINT subject_page_work_home_pkey PRIMARY KEY (partition_no);


--
-- Name: subject subject_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject
    ADD CONSTRAINT subject_pkey PRIMARY KEY (route, subject_id);


--
-- Name: term_head term_head_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.term_head
    ADD CONSTRAINT term_head_pkey PRIMARY KEY (route, subject_id, kind, language);


--
-- Name: acceptance_current_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX acceptance_current_erasure_key ON semantic.acceptance_current USING btree (erasure_key, route);


--
-- Name: acceptance_current_rejected; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX acceptance_current_rejected ON semantic.acceptance_current USING btree (route, subject_id, context_id, slot_id, revision DESC, candidate_id) WHERE (verdict = 'reject'::text);


--
-- Name: acceptance_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX acceptance_erasure_key ON semantic.acceptance USING btree (erasure_key, route);


--
-- Name: acceptance_revision_detail; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX acceptance_revision_detail ON semantic.acceptance USING btree (route, subject_id, revision);


--
-- Name: account_agent_moved_link_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX account_agent_moved_link_erasure_key ON semantic.account_agent_moved_link USING btree (erasure_key, route);


--
-- Name: account_agent_subject_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX account_agent_subject_erasure_key ON semantic.account_agent_subject USING btree (erasure_key, route);


--
-- Name: adoption_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX adoption_erasure_key ON semantic.adoption USING btree (erasure_key, route);


--
-- Name: adoption_revision_detail; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX adoption_revision_detail ON semantic.adoption USING btree (route, subject_id, revision);


--
-- Name: candidate_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX candidate_erasure_key ON semantic.candidate USING btree (erasure_key, route);


--
-- Name: candidate_page; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX candidate_page ON semantic.candidate USING btree (route, subject_id, slot_id, revision, view_order, candidate_id);


--
-- Name: candidate_revision_detail; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX candidate_revision_detail ON semantic.candidate USING btree (route, subject_id, revision);


--
-- Name: candidate_scope_leaf_pair; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX candidate_scope_leaf_pair ON semantic.candidate USING btree (route, subject_id, property, (((statement -> 'value'::text) ->> 'content'::text)), candidate_id) WHERE ((((statement -> 'value'::text) ->> 'type'::text) = 'value'::text) AND (((statement -> 'value'::text) ->> 'content'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text));


--
-- Name: context_active; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_active ON semantic.context USING btree (route, context_id) WHERE (state = 'active'::text);


--
-- Name: context_directory_bootstrap; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_directory_bootstrap ON semantic.context USING btree (route, erasure_key);


--
-- Name: context_directory_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_directory_pending ON semantic.context USING btree (route, erasure_key) WHERE directory_pending;


--
-- Name: context_directory_prefix; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_directory_prefix ON semantic.context_directory_entry USING btree (route, state, search_key, context_id, language);


--
-- Name: context_directory_preparing; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_directory_preparing ON semantic.context_directory_home USING btree (complete, route) WHERE (NOT complete);


--
-- Name: context_directory_raw; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_directory_raw ON semantic.context_directory_entry USING btree (route, state, context_id) WHERE (language = ''::text);


--
-- Name: context_directory_refresh; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_directory_refresh ON semantic.context_directory_entry USING btree (route, context_id) WHERE refresh_pending;


--
-- Name: context_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX context_erasure_key ON semantic.context USING btree (erasure_key, route);


--
-- Name: context_extension_activation_child; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_extension_activation_child ON semantic.context_extension_activation USING btree (route, context_id, digest, head);


--
-- Name: context_extension_activation_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX context_extension_activation_erasure_key ON semantic.context_extension_activation USING btree (erasure_key, route);


--
-- Name: context_extension_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX context_extension_erasure_key ON semantic.context_extension USING btree (erasure_key, route);


--
-- Name: context_global_point; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_global_point ON semantic.context USING btree (route, context_id) WHERE (kind = 'global'::text);


--
-- Name: context_role_enrollment_context; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX context_role_enrollment_context ON semantic.context_role_enrollment USING btree (context_key, route, occurrence);


--
-- Name: definition_activation_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX definition_activation_erasure_key ON semantic.definition_activation USING btree (erasure_key, route);


--
-- Name: definition_catalogue_activation_head; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX definition_catalogue_activation_head ON semantic.definition_catalogue_activation USING btree (route, expected_head);


--
-- Name: definition_catalogue_activation_previous; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_activation_previous ON semantic.definition_catalogue_activation USING btree (route, previous_root, root_digest);


--
-- Name: definition_catalogue_candidates; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_candidates ON semantic.definition_catalogue_kind USING btree (route, root_digest, exact_type_key, precedence DESC, ordinal) WHERE eligible;


--
-- Name: definition_catalogue_consumer_invalidated; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_consumer_invalidated ON semantic.definition_catalogue_consumer USING btree (route, root_digest, sequence) WHERE (state = 'invalidated'::text);


--
-- Name: definition_catalogue_consumer_unresolved; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_consumer_unresolved ON semantic.definition_catalogue_consumer USING btree (route, root_digest, sequence) WHERE (state <> 'invalidated'::text);


--
-- Name: definition_catalogue_frontier_consumer; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_frontier_consumer ON semantic.definition_catalogue_frontier USING btree (route, consumer_id, root_digest);


--
-- Name: definition_catalogue_frontier_reverse; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_frontier_reverse ON semantic.definition_catalogue_frontier USING btree (route, consumer_root, consumer_id, slot);


--
-- Name: definition_catalogue_label_boundary; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX definition_catalogue_label_boundary ON semantic.definition_catalogue_label USING btree (route, root_digest, language_key, ordinal) INCLUDE (label_sort);


--
-- Name: definition_catalogue_node_once; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX definition_catalogue_node_once ON semantic.definition_catalogue_task USING btree (route, root_digest, digest) WHERE (kind = 'node'::text);


--
-- Name: definition_catalogue_original_root; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_original_root ON semantic.definition_catalogue_original USING btree (route, root_digest, original_key);


--
-- Name: definition_catalogue_original_terminal; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_original_terminal ON semantic.definition_catalogue_original USING btree (route, root_digest, original_key) WHERE (state = 'terminal'::text);


--
-- Name: definition_catalogue_original_unsettled; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_original_unsettled ON semantic.definition_catalogue_original USING btree (route, root_digest, original_key) WHERE (state <> 'terminal'::text);


--
-- Name: definition_catalogue_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_pending ON semantic.definition_catalogue_task USING btree (route, root_digest, kind, task_id) WHERE (NOT done);


--
-- Name: definition_catalogue_position_original; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_catalogue_position_original ON semantic.definition_catalogue_position USING btree (route, original_key, root_digest, phase, native_position);


--
-- Name: definition_release_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX definition_release_erasure_key ON semantic.definition_release USING btree (erasure_key, route);


--
-- Name: definition_type_member_page; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX definition_type_member_page ON semantic.definition_catalogue_member USING btree (route, root_digest, category, release_digest, id_key);


--
-- Name: erasure_inbox_source_page; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_inbox_source_page ON semantic.erasure_inbox USING btree (route, account_id, source_partition, store, record_key, role, delivery_position);


--
-- Name: erasure_inbox_unsettled; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_inbox_unsettled ON semantic.erasure_inbox USING btree (route, account_id, source_partition, store, record_key, role, delivery_position) WHERE (late AND (state <> 'resolved'::text));


--
-- Name: erasure_locator_event; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_locator_event ON semantic.erasure_locator USING btree (partition_no, delivery_position, store, record_key, account_id, role);


--
-- Name: erasure_locator_record; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_locator_record ON semantic.erasure_locator USING btree (partition_no, store, record_key, account_id, role);


--
-- Name: erasure_locator_source; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_locator_source ON semantic.erasure_locator USING btree (partition_no, source_transaction_id, store, record_key, account_id, role);


--
-- Name: erasure_locator_work; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_locator_work ON semantic.erasure_locator USING btree (partition_no, account_id, priority, store, record_key, role) WHERE (state = 'pending'::text);


--
-- Name: erasure_source_commit_native_position; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX erasure_source_commit_native_position ON semantic.erasure_source_commit USING btree (partition_no, epoch, "position");


--
-- Name: erasure_source_record_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_source_record_key ON semantic.erasure_source_record USING btree (partition_no, account_id, store, record_key, role, delivery_position, origin_key);


--
-- Name: erasure_source_record_origin; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX erasure_source_record_origin ON semantic.erasure_source_record USING btree (partition_no, account_id, role, store, record_key, COALESCE((source_transaction_id)::text, ''::text), source_position);


--
-- Name: external_claim_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX external_claim_erasure_key ON semantic.external_claim USING btree (erasure_key, route);


--
-- Name: facet_population_expiry; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX facet_population_expiry ON semantic.facet_population_frontier USING btree (partition_no, expires, frontier);


--
-- Name: facet_population_successor; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX facet_population_successor ON semantic.facet_population_frontier USING btree (partition_no, predecessor) WHERE (predecessor IS NOT NULL);


--
-- Name: fact_compact_candidate; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_compact_candidate ON semantic.fact USING btree (route, subject_id, statement_id, log_seq DESC) WHERE ((kind = 'statement'::text) AND (operation = 'assert'::text) AND (statement_id IS NOT NULL));


--
-- Name: fact_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX fact_erasure_key ON semantic.fact USING btree (erasure_key, route);


--
-- Name: fact_label; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_label ON semantic.fact USING btree (route, subject_id, language) WHERE ((kind = 'label'::text) AND (operation = 'assert'::text));


--
-- Name: fact_publication_descriptive; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_publication_descriptive ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE (NOT relation);


--
-- Name: fact_publication_relations; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_publication_relations ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE relation;


--
-- Name: fact_scope_leaf_pair; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_scope_leaf_pair ON semantic.fact USING btree (route, subject_id, property, (((body -> 'value'::text) ->> 'content'::text)), erasure_key) WHERE ((kind = 'statement'::text) AND (operation = 'assert'::text) AND (((body -> 'value'::text) ->> 'type'::text) = 'value'::text) AND (((body -> 'value'::text) ->> 'content'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text));


--
-- Name: fact_statement_identity; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_statement_identity ON semantic.fact USING btree (route, subject_id, statement_id, log_seq DESC) WHERE ((kind = 'statement'::text) AND (statement_id IS NOT NULL));


--
-- Name: fact_subject_slot_order; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_subject_slot_order ON semantic.fact USING btree (route, subject_id, slot_id, log_seq);


--
-- Name: fact_terms; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_terms ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE (kind <> 'statement'::text);


--
-- Name: hidden_candidate_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX hidden_candidate_erasure_key ON semantic.hidden_candidate USING btree (erasure_key, route);


--
-- Name: identity_epoch_ack_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_ack_erasure_key ON semantic.identity_epoch_ack USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_admission_attempt_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_admission_attempt_erasure_key ON semantic.identity_epoch_admission_attempt USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_admission_plan_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_admission_plan_erasure_key ON semantic.identity_epoch_admission_plan USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_admission_receipt_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_admission_receipt_erasure_key ON semantic.identity_epoch_admission_receipt USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_admission_source_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_admission_source_erasure_key ON semantic.identity_epoch_admission_source USING btree (erasure_key, route);


--
-- Name: identity_epoch_admission_waiters; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_admission_waiters ON semantic.identity_epoch_admission_plan USING btree (resource_home, job_id) WHERE waiting;


--
-- Name: identity_epoch_bootstrap_repair; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_bootstrap_repair ON semantic.identity_epoch_bootstrap_home USING btree (partition_no) WHERE needs_work;


--
-- Name: identity_epoch_bootstrap_unacknowledged; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_bootstrap_unacknowledged ON semantic.identity_epoch_bootstrap_page USING btree (partition_no, generation) WHERE (NOT acknowledged);


--
-- Name: identity_epoch_change_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_change_erasure_key ON semantic.identity_epoch_change USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_current_original; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_current_original ON semantic.identity_epoch_original USING btree (partition_no, original) WHERE present;


--
-- Name: identity_epoch_dirty_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_dirty_pending ON semantic.identity_epoch_dirty USING btree (route, original) WHERE (revision > captured_revision);


--
-- Name: identity_epoch_effect_receipt_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_effect_receipt_erasure_key ON semantic.identity_epoch_effect_receipt USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_home_gate_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_home_gate_erasure_key ON semantic.identity_epoch_home_gate USING btree (erasure_key, route);


--
-- Name: identity_epoch_input_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_input_erasure_key ON semantic.identity_epoch_input USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_job_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_job_erasure_key ON semantic.identity_epoch_job USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_job_home_epoch; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_job_home_epoch ON semantic.identity_epoch_job USING btree (partition_no, epoch);


--
-- Name: identity_epoch_job_receipt; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_job_receipt ON semantic.identity_epoch_job USING btree (partition_no, receipt_key);


--
-- Name: identity_epoch_live_original; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_live_original ON semantic.identity_epoch_original USING btree (partition_no, generation, original) WHERE present;


--
-- Name: identity_epoch_mapping_effect_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_effect_erasure_key ON semantic.identity_epoch_mapping_effect USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_mapping_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_erasure_key ON semantic.identity_epoch_mapping USING btree (erasure_key, route);


--
-- Name: identity_epoch_mapping_fact_revision; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_mapping_fact_revision ON semantic.revision USING btree (route, subject_id, revision DESC) WHERE (kind <> 'merge'::text);


--
-- Name: identity_epoch_mapping_fence_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_fence_erasure_key ON semantic.identity_epoch_mapping_fence USING btree (route, erasure_key);


--
-- Name: identity_epoch_mapping_generation_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_generation_erasure_key ON semantic.identity_epoch_mapping_generation USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_mapping_head_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_head_erasure_key ON semantic.identity_epoch_mapping_head USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_mapping_payload_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_payload_erasure_key ON semantic.identity_epoch_mapping_payload USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_mapping_plan_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_plan_erasure_key ON semantic.identity_epoch_mapping_plan USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_mapping_undo_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_undo_erasure_key ON semantic.identity_epoch_mapping_undo USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_mapping_withdrawal_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_mapping_withdrawal_erasure_key ON semantic.identity_epoch_mapping_withdrawal USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_member_dirty_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_member_dirty_pending ON semantic.identity_epoch_member_dirty USING btree (route, terminal, original) WHERE (revision > captured_revision);


--
-- Name: identity_epoch_one_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_one_pending ON semantic.identity_epoch_job USING btree (partition_no) WHERE (state = ANY (ARRAY['preparing'::text, 'pending'::text, 'cancelling'::text]));


--
-- Name: identity_epoch_original_group; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_original_group ON semantic.identity_epoch_original USING btree (terminal, original) WHERE present;


--
-- Name: identity_epoch_original_source; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_original_source ON semantic.identity_epoch_original USING btree (source_partition, original) WHERE present;


--
-- Name: identity_epoch_prearm_bridge_held; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_prearm_bridge_held ON semantic.identity_epoch_prearm_bridge USING btree (partition_no, job_id, generation) WHERE (job_id IS NOT NULL);


--
-- Name: identity_epoch_prearm_directory_unsealed; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_prearm_directory_unsealed ON semantic.identity_epoch_prearm_directory USING btree (partition_no, job_id, generation) WHERE (sealed_transaction_id IS NULL);


--
-- Name: identity_epoch_prearm_input_uncancelled; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_prearm_input_uncancelled ON semantic.identity_epoch_input USING btree (partition_no, job_id, terminal) WHERE (prearm_cancelled_transaction_id IS NULL);


--
-- Name: identity_epoch_prearm_input_unsealed; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_prearm_input_unsealed ON semantic.identity_epoch_input USING btree (partition_no, job_id, terminal) WHERE (prearm_transaction_id IS NULL);


--
-- Name: identity_epoch_prearm_page_order; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_prearm_page_order ON semantic.identity_epoch_prearm_page USING btree (partition_no, job_id, generation, sequence, page_id);


--
-- Name: identity_epoch_preparing_home; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_preparing_home ON semantic.identity_epoch_job USING btree (partition_no) WHERE (state = ANY (ARRAY['preparing'::text, 'cancelling'::text]));


--
-- Name: identity_epoch_receipt_account; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_receipt_account ON semantic.identity_epoch_receipt_binding USING btree (partition_no, account_id, receipt_key);


--
-- Name: identity_epoch_receiving_custody_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_receiving_custody_erasure_key ON semantic.identity_epoch_receiving_custody USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_receiving_effect_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_receiving_effect_erasure_key ON semantic.identity_epoch_receiving_effect USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_receiving_plan_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_receiving_plan_erasure_key ON semantic.identity_epoch_receiving_plan USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_receiving_record_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_receiving_record_erasure_key ON semantic.identity_epoch_receiving_record USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_receiving_search_unreleased; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_receiving_search_unreleased ON semantic.identity_epoch_receiving_search_progress USING btree (partition_no, job_id, owner_id, original) WHERE (state <> 'released'::text);


--
-- Name: identity_epoch_scoped_generation_original; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_scoped_generation_original ON semantic.identity_epoch_original USING btree (partition_no, generation, terminal, original) WHERE present;


--
-- Name: identity_epoch_source_consumer_custody_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_source_consumer_custody_erasure_key ON semantic.identity_epoch_source_consumer_custody USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_source_hold_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_source_hold_key ON semantic.identity_epoch_admission_source_hold USING btree (partition_no, route, original) WHERE (NOT closed);


--
-- Name: identity_epoch_step_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_step_erasure_key ON semantic.identity_epoch_step USING btree (partition_no, erasure_key);


--
-- Name: identity_epoch_topology_open_home; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_topology_open_home ON semantic.identity_epoch_bootstrap_topology_home USING btree (source_partition) WHERE (NOT closed);


--
-- Name: identity_public_dirty_revision; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_public_dirty_revision ON semantic.identity_public_dirty USING btree (partition_no, revision, original);


--
-- Name: identity_receipt_claim_native_command; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_receipt_claim_native_command ON semantic.identity_epoch_receipt_claim USING btree (partition_no, transaction_id) WHERE (NOT imported);


--
-- Name: identity_receiving_capture_event; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_receiving_capture_event ON semantic.identity_receiving_capture_pending USING btree (transaction_xid, partition_no, store, record_key, ordinal);


--
-- Name: identity_scope_active_attempt; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_scope_active_attempt ON semantic.identity_scope_attempt USING btree (partition_no, source_key, scope_id, registration, job_id, job_epoch) WHERE (state = 'active'::text);


--
-- Name: identity_scope_forward_unresolved; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_scope_forward_unresolved ON semantic.identity_scope_forward USING btree (partition_no, source_key, scope_id, registration, dependency) WHERE (ticket IS NULL);


--
-- Name: identity_scope_pending_groups; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_scope_pending_groups ON semantic.identity_epoch_group USING btree (partition_no, terminal) WHERE (pending_job IS NOT NULL);


--
-- Name: identity_scope_repair_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_scope_repair_pending ON semantic.identity_scope_summary USING btree (partition_no, source_key, scope_id) WHERE (state = ANY (ARRAY['capturing'::text, 'enrolling'::text, 'repair'::text, 'retiring'::text]));


--
-- Name: identity_terminal_closure_cancelled; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_closure_cancelled ON semantic.identity_epoch_mapping USING btree (route, original) WHERE closure_cancelled_successor;


--
-- Name: identity_terminal_closure_cleanup; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_closure_cleanup ON semantic.identity_epoch_group USING btree (partition_no, terminal) WHERE ((closure_state = ANY (ARRAY['closing'::text, 'drained'::text])) AND (NOT closure_cleanup_complete));


--
-- Name: identity_terminal_closure_directory; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_closure_directory ON semantic.identity_epoch_original USING btree (partition_no, terminal, generation, original) INCLUDE (closure_state, closure_enrollment);


--
-- Name: identity_terminal_closure_owner; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_closure_owner ON semantic.identity_epoch_mapping USING btree (route, closure_state) WHERE (closure_state <> 'legacy'::text);


--
-- Name: identity_terminal_closure_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_closure_pending ON semantic.identity_epoch_mapping USING btree (route, original) WHERE (closure_state = ANY (ARRAY['exporting'::text, 'installed'::text]));


--
-- Name: identity_terminal_closure_successor; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_closure_successor ON semantic.identity_epoch_mapping USING btree (route, original) WHERE (closure_successor_ticket IS NOT NULL);


--
-- Name: identity_terminal_closure_unreleased; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_closure_unreleased ON semantic.identity_epoch_original USING btree (partition_no, terminal, generation, original) WHERE ((closure_state = 'withdrawn'::text) AND (closure_release_transaction IS NULL));


--
-- Name: identity_terminal_directory_allocation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_directory_allocation ON semantic.identity_epoch_original USING btree (partition_no, closure_reservation) WHERE (closure_reservation IS NOT NULL);


--
-- Name: identity_terminal_group_allocation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_group_allocation ON semantic.identity_epoch_group USING btree (partition_no, closure_claim) WHERE (closure_claim IS NOT NULL);


--
-- Name: identity_terminal_page_allocation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_page_allocation ON semantic.identity_epoch_bootstrap_page USING btree (partition_no, closure_page_reservation) WHERE (closure_page_reservation IS NOT NULL);


--
-- Name: identity_terminal_source_allocation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_source_allocation ON semantic.identity_epoch_mapping USING btree (((route / 16)), closure_source_reservation) WHERE (closure_source_reservation IS NOT NULL);


--
-- Name: identity_terminal_successor_allocation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_terminal_successor_allocation ON semantic.identity_epoch_mapping USING btree (((route / 16)), closure_ticket_reservation) WHERE (closure_ticket_reservation IS NOT NULL);


--
-- Name: inbound_link_all_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_all_present ON semantic.inbound_link USING btree (route, subject_id, context_id, property, source_subject_id, statement_id) INCLUDE (source_type, suppressed) WHERE (present AND (filter_value = '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: inbound_link_context_overrides; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_context_overrides ON semantic.inbound_link USING btree (route, subject_id, property, filter_value, statement_id, source_subject_id, context_id) WHERE (present AND (context_id <> '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: inbound_link_count_unfiltered; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_count_unfiltered ON semantic.inbound_link_count USING btree (route, subject_id, property) INCLUDE (value) WHERE ((filter_value = '00000000-0000-0000-0000-000000000000'::uuid) AND (value > 0));


--
-- Name: inbound_link_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX inbound_link_erasure_key ON semantic.inbound_link USING btree (erasure_key, route);


--
-- Name: inbound_link_key_reemit; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_key_reemit ON semantic.inbound_link USING btree (route, subject_id, property, source_subject_id, statement_id, filter_value, context_id) WHERE present;


--
-- Name: inbound_link_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_present ON semantic.inbound_link USING btree (route, subject_id, context_id, property, filter_value, order_key, source_subject_id, statement_id) INCLUDE (source_type, suppressed) WHERE present;


--
-- Name: merge_member_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX merge_member_pending ON semantic.merge_member USING btree (route, subject_id, member_id) WHERE (phase <> 'done'::text);


--
-- Name: moderation_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX moderation_erasure_key ON semantic.moderation USING btree (erasure_key, route);


--
-- Name: outbound_link_context_overrides; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_context_overrides ON semantic.outbound_link USING btree (route, subject_id, property, filter_value, statement_id, target_subject_id, context_id) WHERE (present AND (context_id <> '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: outbound_link_count_unfiltered; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_count_unfiltered ON semantic.outbound_link_count USING btree (route, subject_id, property) INCLUDE (value) WHERE ((filter_value = '00000000-0000-0000-0000-000000000000'::uuid) AND (value > 0));


--
-- Name: outbound_link_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX outbound_link_erasure_key ON semantic.outbound_link USING btree (erasure_key, route);


--
-- Name: outbound_link_identity; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_identity ON semantic.outbound_link USING btree (route, subject_id, context_id, property, statement_id, filter_value) WHERE present;


--
-- Name: outbound_link_key_reemit; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_key_reemit ON semantic.outbound_link USING btree (route, subject_id, property, target_subject_id, statement_id, filter_value, context_id) WHERE (present AND relation);


--
-- Name: outbound_link_maintenance; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_maintenance ON semantic.outbound_link USING btree (route, subject_id, property, target_subject_id, statement_id, filter_value, context_id) WHERE present;


--
-- Name: outbound_link_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_present ON semantic.outbound_link USING btree (route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id) INCLUDE (relation, target_type, suppressed) WHERE present;


--
-- Name: outbound_link_statement; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_statement ON semantic.outbound_link USING btree (route, subject_id, context_id, property, filter_value, statement_id, source_revision DESC, source_security_revision DESC, target_revision DESC);


--
-- Name: provider_review_queue_entry_erasure; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX provider_review_queue_entry_erasure ON semantic.provider_review_queue_entry USING btree (route, erasure_key);


--
-- Name: provider_review_queue_key_erasure; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX provider_review_queue_key_erasure ON semantic.provider_review_queue_key USING btree (route, erasure_key);


--
-- Name: provider_review_queue_key_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX provider_review_queue_key_pending ON semantic.provider_review_queue_key USING btree (route, captured_position, erasure_key) WHERE (NOT published);


--
-- Name: public_filter_bootstrap_capture; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX public_filter_bootstrap_capture ON semantic.public_filter_bootstrap USING btree (partition_no, request_key) WHERE (state = 'capturing'::text);


--
-- Name: public_filter_key_enrollment_window; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX public_filter_key_enrollment_window ON semantic.public_filter_key_enrollment USING btree (partition_no, input_key, enrollment_generation, registration_partition, registration, bootstrap);


--
-- Name: public_filter_population_fenced; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX public_filter_population_fenced ON semantic.public_filter_privacy_head USING btree (partition_no) WHERE population_fenced;


--
-- Name: public_filter_population_start_observation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX public_filter_population_start_observation ON semantic.public_filter_population_start USING btree (partition_no, observation, id);


--
-- Name: public_filter_privacy_pending_home; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX public_filter_privacy_pending_home ON semantic.public_filter_privacy_pending USING btree (partition_no, input_key) WHERE live;


--
-- Name: public_filter_privacy_pending_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX public_filter_privacy_pending_key ON semantic.public_filter_privacy_pending USING btree (input_key, partition_no) WHERE live;


--
-- Name: public_filter_repair_root; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX public_filter_repair_root ON semantic.public_filter_repair_step USING btree (partition_no, bootstrap, execution) WHERE (predecessor IS NULL);


--
-- Name: public_filter_repair_verified_home; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX public_filter_repair_verified_home ON semantic.public_filter_repair_step USING btree (partition_no, bootstrap, execution, verified_home) WHERE (verified_home IS NOT NULL);


--
-- Name: public_filter_repair_verified_tip; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX public_filter_repair_verified_tip ON semantic.public_filter_repair_step USING btree (partition_no, bootstrap, execution) WHERE ((verified_root IS NOT NULL) AND (verified_next IS NULL));


--
-- Name: record_purge_hold_gate; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_purge_hold_gate ON semantic.record_purge_hold USING btree (route, kind, owner_id, record_id) WHERE (NOT released);


--
-- Name: record_purge_hold_source_home; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_purge_hold_source_home ON semantic.record_purge_hold USING btree (partition_no) WHERE (NOT released);


--
-- Name: record_retention_activation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_activation ON semantic.context_extension_activation USING btree (route, context_id, erasure_key);


--
-- Name: record_retention_composite; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_composite ON semantic.release_composite USING btree (extension_route, extension_context_id, erasure_key);


--
-- Name: record_retention_disclosure; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_disclosure ON semantic.statement_disclosure USING btree (route, subject_id, candidate_id, erasure_key);


--
-- Name: record_retention_document_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_document_pending ON semantic.record_retention_document USING btree (route, subject_id, candidate_id, deletion_generation, document_id) WHERE (NOT minimized);


--
-- Name: record_retention_extension; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_extension ON semantic.context_extension USING btree (route, context_id, erasure_key);


--
-- Name: record_retention_fact; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_fact ON semantic.fact USING btree (route, subject_id, statement_id, erasure_key);


--
-- Name: record_retention_moderation; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_moderation ON semantic.moderation USING btree (route, subject_id, candidate_id, erasure_key);


--
-- Name: record_retention_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_pending ON semantic.record_retention_key USING btree (partition_no, key) WHERE (phase <> 'complete'::text);


--
-- Name: record_retention_retraction; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_retraction ON semantic.retraction USING btree (route, subject_id, candidate_id, erasure_key);


--
-- Name: record_retention_source; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_retention_source ON semantic.source_candidate USING btree (route, subject_id, candidate_id, erasure_key);


--
-- Name: record_source_set_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX record_source_set_erasure_key ON semantic.record_source_set USING btree (erasure_key, route);


--
-- Name: record_source_set_fact_origin; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_source_set_fact_origin ON semantic.fact USING btree (route, subject_id, recorded_transaction_id, kind, statement_id);


--
-- Name: record_source_set_member_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX record_source_set_member_erasure_key ON semantic.record_source_set_member USING btree (erasure_key, route);


--
-- Name: record_source_set_member_lookup; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_source_set_member_lookup ON semantic.record_source_set_member USING btree (partition_no, source_hash, transaction_id);


--
-- Name: record_source_set_member_unit; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_source_set_member_unit ON semantic.record_source_set_member USING btree (partition_no, transaction_id, unit_hash, source_revision);


--
-- Name: record_source_set_member_version; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_source_set_member_version ON semantic.record_source_set_member USING btree (partition_no, transaction_id, subject_id, candidate_id, source_revision);


--
-- Name: record_source_set_native_transaction; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX record_source_set_native_transaction ON semantic.record_source_set USING btree (partition_no, native_xid);


--
-- Name: redirect_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX redirect_erasure_key ON semantic.redirect USING btree (erasure_key, route);


--
-- Name: release_composite_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX release_composite_erasure_key ON semantic.release_composite USING btree (erasure_key, extension_route);


--
-- Name: release_composite_extension; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX release_composite_extension ON semantic.release_composite USING btree (extension_route, extension_context_id, extension_digest, digest);


--
-- Name: retraction_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX retraction_erasure_key ON semantic.retraction USING btree (erasure_key, route);


--
-- Name: revision_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX revision_erasure_key ON semantic.revision USING btree (erasure_key, route);


--
-- Name: revision_identity_version; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX revision_identity_version ON semantic.revision USING btree (route, subject_id, revision DESC) INCLUDE (recorded_transaction_id) WHERE (kind = ANY (ARRAY['create'::text, 'identity'::text]));


--
-- Name: revision_transaction; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX revision_transaction ON semantic.revision USING btree (recorded_transaction_id, route, subject_id);


--
-- Name: search_adoption_rebuild; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX search_adoption_rebuild ON semantic.adoption USING btree (route, subject_id, slot_id, head) WHERE (context_id = '00000000-0000-8000-8000-000000000000'::uuid);


--
-- Name: search_fact_descriptive; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX search_fact_descriptive ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE ((kind = 'statement'::text) AND (NOT relation));


--
-- Name: search_fact_rebuild; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX search_fact_rebuild ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE (kind = 'statement'::text);


--
-- Name: search_fact_terms; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX search_fact_terms ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE (kind <> 'statement'::text);


--
-- Name: search_selected_page; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX search_selected_page ON semantic.search_selected USING btree (route, subject_id, property, slot_id, candidate_id) WHERE active;


--
-- Name: search_selected_value; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX search_selected_value ON semantic.search_selected USING btree (route, subject_id, property, (((body -> 'value'::text) ->> 'content'::text)) COLLATE "C", slot_id, candidate_id) WHERE active;


--
-- Name: source_candidate_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX source_candidate_erasure_key ON semantic.source_candidate USING btree (erasure_key, route);


--
-- Name: source_candidate_provider_review; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX source_candidate_provider_review ON semantic.source_candidate USING btree (route, source, erasure_key);


--
-- Name: source_candidate_retract; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX source_candidate_retract ON semantic.source_candidate USING btree (route, subject_id, candidate_id, source, external_id, field_group);


--
-- Name: source_candidate_review_discovery_tuple; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX source_candidate_review_discovery_tuple ON semantic.source_candidate USING btree (route, source, external_id, field_group, subject_id);


--
-- Name: source_record_tuple_point; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX source_record_tuple_point ON semantic.source_record USING hash (((((((route)::text || ':'::text) || source) || ':'::text) || external_id)));


--
-- Name: statement_disclosure_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX statement_disclosure_erasure_key ON semantic.statement_disclosure USING btree (erasure_key, route);


--
-- Name: statement_disclosure_inbound; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX statement_disclosure_inbound ON semantic.statement_disclosure USING btree (target_id, account_id, property, source_order_key, subject_id, candidate_id) WHERE (NOT disclosed);


--
-- Name: statement_disclosure_outbound; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX statement_disclosure_outbound ON semantic.statement_disclosure USING btree (subject_id, account_id, property, target_order_key, target_id, candidate_id) WHERE (NOT disclosed);


--
-- Name: subject_erasure_key; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX subject_erasure_key ON semantic.subject USING btree (erasure_key, route);


--
-- Name: subject_page_component_witness; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX subject_page_component_witness ON semantic.subject_page_component USING btree (route, subject_id, generation, component_kind, component_key) WHERE (shown AND (component_kind <> 'label'::text));


--
-- Name: subject_page_dependency_component; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX subject_page_dependency_component ON semantic.subject_page_dependency USING btree (route, subject_id, component_key, owner_kind, owner_route, owner_key) WHERE present;


--
-- Name: subject_page_fanout_runnable; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX subject_page_fanout_runnable ON semantic.subject_page_fanout USING btree (route, state, available_at, owner_kind, owner_key, change_id);


--
-- Name: subject_page_owner_dependency_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX subject_page_owner_dependency_present ON semantic.subject_page_owner_dependency USING btree (route, owner_kind, owner_key, source_route, source_subject_id, component_key) WHERE present;


--
-- Name: subject_page_repair_runnable; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX subject_page_repair_runnable ON semantic.subject_page_repair USING btree (route, state, available_at, subject_id);


--
-- Name: term_head_active; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX term_head_active ON semantic.term_head USING btree (route, subject_id, kind, language) WHERE active;


--
-- Name: acceptance_current acceptance_current_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER acceptance_current_erasure_capture AFTER INSERT OR UPDATE ON semantic.acceptance_current DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_acceptance_current_erasure();


--
-- Name: acceptance acceptance_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER acceptance_erasure_capture AFTER INSERT OR UPDATE ON semantic.acceptance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_acceptance_erasure();


--
-- Name: acceptance acceptance_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER acceptance_immutable BEFORE DELETE OR UPDATE ON semantic.acceptance FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: acceptance acceptance_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER acceptance_immutable_truncate BEFORE TRUNCATE ON semantic.acceptance FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: account_agent_moved_link account_agent_moved_link_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER account_agent_moved_link_erasure_capture AFTER INSERT OR UPDATE ON semantic.account_agent_moved_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_account_agent_moved_link_erasure();


--
-- Name: account_agent_subject account_agent_subject_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER account_agent_subject_erasure_capture AFTER INSERT OR UPDATE ON semantic.account_agent_subject DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_account_agent_subject_erasure();


--
-- Name: adoption adoption_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER adoption_erasure_capture AFTER INSERT OR UPDATE ON semantic.adoption DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_adoption_erasure();


--
-- Name: adoption adoption_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER adoption_immutable BEFORE DELETE OR UPDATE ON semantic.adoption FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: adoption adoption_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER adoption_immutable_truncate BEFORE TRUNCATE ON semantic.adoption FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: candidate candidate_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER candidate_erasure_capture AFTER INSERT OR UPDATE ON semantic.candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_candidate_erasure();


--
-- Name: candidate candidate_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER candidate_immutable BEFORE DELETE OR UPDATE ON semantic.candidate FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: candidate candidate_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER candidate_immutable_truncate BEFORE TRUNCATE ON semantic.candidate FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: candidate candidate_record_purge_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER candidate_record_purge_gate BEFORE DELETE OR UPDATE ON semantic.candidate FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: context_extension_activation context_activation_record_purge_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER context_activation_record_purge_gate BEFORE INSERT OR DELETE OR UPDATE ON semantic.context_extension_activation FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: context_extension_activation context_activation_record_purge_writer; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_activation_record_purge_writer AFTER INSERT OR UPDATE ON semantic.context_extension_activation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();


--
-- Name: context context_directory_dirty; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER context_directory_dirty BEFORE INSERT OR UPDATE ON semantic.context FOR EACH ROW EXECUTE FUNCTION semantic.context_directory_dirty();


--
-- Name: context_directory_entry context_directory_entry_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_directory_entry_erasure AFTER INSERT OR UPDATE ON semantic.context_directory_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_directory_entry();


--
-- Name: erasure_source_record context_directory_source_record; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER context_directory_source_record BEFORE INSERT ON semantic.erasure_source_record FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_directory_source_record();


--
-- Name: context context_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_erasure_capture AFTER INSERT OR UPDATE ON semantic.context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_erasure();


--
-- Name: context_extension_activation context_extension_activation_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_extension_activation_erasure_capture AFTER INSERT OR UPDATE ON semantic.context_extension_activation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_extension_activation_erasure();


--
-- Name: context_extension context_extension_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_extension_erasure_capture AFTER INSERT OR UPDATE ON semantic.context_extension DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_context_extension_erasure();


--
-- Name: context_extension context_extension_record_purge_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER context_extension_record_purge_gate BEFORE INSERT OR DELETE OR UPDATE ON semantic.context_extension FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: context_extension context_extension_record_purge_writer; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_extension_record_purge_writer AFTER INSERT OR UPDATE ON semantic.context_extension DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();


--
-- Name: context context_record_purge_commit; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_record_purge_commit AFTER UPDATE ON semantic.context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.resource_record_purge_commit();


--
-- Name: context context_record_purge_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER context_record_purge_gate BEFORE DELETE OR UPDATE ON semantic.context FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: context context_record_purge_generation; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER context_record_purge_generation BEFORE UPDATE ON semantic.context FOR EACH ROW EXECUTE FUNCTION semantic.resource_record_purge_generation();


--
-- Name: context context_record_purge_writer; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_record_purge_writer AFTER INSERT OR UPDATE ON semantic.context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();


--
-- Name: context context_record_retention; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER context_record_retention AFTER INSERT OR UPDATE OF state, deleted_at ON semantic.context FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_retention();


--
-- Name: context_role_enrollment context_role_enrollment_native_commit; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER context_role_enrollment_native_commit AFTER INSERT ON semantic.context_role_enrollment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_context_role_enrollment();


--
-- Name: record_lifecycle contribution_record_purge_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER contribution_record_purge_gate BEFORE DELETE OR UPDATE ON semantic.record_lifecycle FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: definition_activation definition_activation_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER definition_activation_erasure_capture AFTER INSERT OR UPDATE ON semantic.definition_activation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_definition_activation_erasure();


--
-- Name: definition_release definition_release_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER definition_release_erasure_capture AFTER INSERT OR UPDATE ON semantic.definition_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_definition_release_erasure();


--
-- Name: erasure_source_commit erasure_source_native_commit; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_native_commit AFTER INSERT ON semantic.erasure_source_commit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_erasure_source_commit();


--
-- Name: erasure_source_commit erasure_source_native_commit_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER erasure_source_native_commit_immutable BEFORE DELETE OR UPDATE ON semantic.erasure_source_commit FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: erasure_locator erasure_source_record_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER erasure_source_record_capture AFTER INSERT OR UPDATE OF source_transaction_id, source_position, delivery_position ON semantic.erasure_locator FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_record();


--
-- Name: acceptance erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.acceptance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: acceptance_current erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.acceptance_current DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: account_agent_moved_link erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.account_agent_moved_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: account_agent_subject erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.account_agent_subject DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: adoption erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.adoption DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: candidate erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: context erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: context_directory_entry erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context_directory_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: context_extension erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context_extension DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: context_extension_activation erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.context_extension_activation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: definition_activation erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.definition_activation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: definition_release erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.definition_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: external_claim erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.external_claim DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: fact erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: hidden_candidate erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.hidden_candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_ack erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_ack DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_admission_attempt erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_admission_plan erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_plan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_admission_receipt erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_admission_source erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_admission_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_change erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_change DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_effect_receipt erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_effect_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_home_gate erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_home_gate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_input erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_input DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_job erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_job DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_mapping erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_mapping DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_bridge erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_bridge DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_claim erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_claim DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_custody erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_decision erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_directory erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_directory DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_disposition erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_disposition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_inverse erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_inverse DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_prearm_page erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_prearm_page DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_receiving_custody erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_receiving_effect erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_receiving_plan erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_plan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_receiving_record erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_receiving_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: identity_epoch_step erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.identity_epoch_step DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: inbound_link erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.inbound_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: moderation erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.moderation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: outbound_link erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.outbound_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: provider_review_queue_entry erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.provider_review_queue_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: provider_review_queue_key erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.provider_review_queue_key DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: redirect erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.redirect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: release_composite erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.release_composite DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: retraction erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.retraction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: revision erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: source_candidate erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.source_candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: statement_disclosure erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.statement_disclosure DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: subject erasure_source_removed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER erasure_source_removed AFTER DELETE ON semantic.subject DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_erasure_source_removal();


--
-- Name: external_claim external_claim_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER external_claim_erasure_capture AFTER INSERT OR UPDATE ON semantic.external_claim DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_external_claim_erasure();


--
-- Name: external_claim external_claim_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER external_claim_immutable BEFORE DELETE OR UPDATE ON semantic.external_claim FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: external_claim external_claim_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER external_claim_immutable_truncate BEFORE TRUNCATE ON semantic.external_claim FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: fact fact_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER fact_erasure_capture AFTER INSERT OR UPDATE ON semantic.fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_fact_erasure();


--
-- Name: fact fact_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER fact_immutable BEFORE DELETE OR UPDATE ON semantic.fact FOR EACH ROW EXECUTE FUNCTION semantic.prevent_fact_mutation();


--
-- Name: fact fact_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER fact_immutable_truncate BEFORE TRUNCATE ON semantic.fact FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: fact fact_term_head; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER fact_term_head AFTER INSERT ON semantic.fact FOR EACH ROW EXECUTE FUNCTION semantic.capture_term_head();


--
-- Name: subject follow_count_new_subject; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER follow_count_new_subject AFTER INSERT ON semantic.subject FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_total();


--
-- Name: hidden_candidate hidden_candidate_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER hidden_candidate_erasure_capture AFTER INSERT OR UPDATE ON semantic.hidden_candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_hidden_candidate_erasure();


--
-- Name: hidden_candidate hidden_record_purge_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER hidden_record_purge_gate BEFORE INSERT OR DELETE OR UPDATE ON semantic.hidden_candidate FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: identity_epoch_receipt_binding identity_binding_consumer_birth; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_binding_consumer_birth AFTER INSERT OR UPDATE ON semantic.identity_epoch_receipt_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_identity_binding_consumer_birth();


--
-- Name: identity_epoch_ack identity_epoch_ack_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_ack_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_ack DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_ack_erasure();


--
-- Name: identity_epoch_admission_attempt identity_epoch_admission_attempt_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_admission_attempt_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_attempt_erasure();


--
-- Name: identity_epoch_admission_handoff identity_epoch_admission_handoff_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_admission_handoff_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_admission_handoff FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_admission_plan identity_epoch_admission_plan_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_admission_plan_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_plan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_plan_erasure();


--
-- Name: identity_epoch_admission_receipt identity_epoch_admission_receipt_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_admission_receipt_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_receipt_erasure();


--
-- Name: identity_epoch_admission_receipt identity_epoch_admission_receipt_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_admission_receipt_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_admission_receipt FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_admission_source identity_epoch_admission_source_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_admission_source_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_admission_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_admission_source_erasure();


--
-- Name: identity_epoch_admission_validation identity_epoch_admission_validation_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_admission_validation_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_admission_validation FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: subject identity_epoch_birth_custody; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_birth_custody AFTER INSERT ON semantic.subject DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_epoch_birth();

ALTER TABLE semantic.subject DISABLE TRIGGER identity_epoch_birth_custody;


--
-- Name: identity_epoch_bootstrap_basis identity_epoch_bootstrap_basis_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_bootstrap_basis_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_bootstrap_basis FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_bootstrap_custody identity_epoch_bootstrap_custody_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_bootstrap_custody_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_bootstrap_custody FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: account_agent_subject identity_epoch_capture_backlink; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_backlink AFTER DELETE OR UPDATE ON semantic.account_agent_subject FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: merge_member identity_epoch_capture_member; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_member AFTER INSERT OR DELETE OR UPDATE ON semantic.merge_member FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: redirect identity_epoch_capture_redirect; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_redirect AFTER INSERT OR DELETE OR UPDATE ON semantic.redirect FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: subject identity_epoch_capture_subject; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_subject AFTER INSERT OR DELETE ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: identity_epoch_change identity_epoch_change_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_change_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_change DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_change_erasure();


--
-- Name: identity_epoch_change identity_epoch_change_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_change_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_change FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_change identity_epoch_change_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_change_immutable_truncate BEFORE TRUNCATE ON semantic.identity_epoch_change FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_effect_receipt identity_epoch_effect_receipt_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_effect_receipt_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_effect_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_effect_receipt_erasure();


--
-- Name: identity_epoch_home_gate identity_epoch_home_gate_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_home_gate_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_home_gate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_home_gate_erasure();


--
-- Name: identity_epoch_input identity_epoch_input_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_input_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_input DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_input_erasure();


--
-- Name: identity_epoch_installation_cut identity_epoch_installation_cut_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_installation_cut_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_installation_cut FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_installation_cut identity_epoch_installation_cut_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_installation_cut_immutable_truncate BEFORE TRUNCATE ON semantic.identity_epoch_installation_cut FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_installation identity_epoch_installation_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_installation_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_installation FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_installation identity_epoch_installation_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_installation_immutable_truncate BEFORE TRUNCATE ON semantic.identity_epoch_installation FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_job identity_epoch_job_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_job_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_job DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_job_erasure();


--
-- Name: identity_epoch_job identity_epoch_job_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_job_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_job FOR EACH ROW EXECUTE FUNCTION semantic.protect_identity_epoch_job();


--
-- Name: identity_epoch_mapping_effect identity_epoch_mapping_effect_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_effect_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: identity_epoch_mapping_effect identity_epoch_mapping_effect_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_mapping_effect_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_mapping_effect FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_mapping identity_epoch_mapping_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_erasure();


--
-- Name: identity_epoch_mapping_fence identity_epoch_mapping_fence_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_fence_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_fence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: identity_epoch_mapping_generation identity_epoch_mapping_generation_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_generation_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_generation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: identity_epoch_mapping_head identity_epoch_mapping_head_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_head_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_head DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: inbound_link identity_epoch_mapping_inbound_guard; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_mapping_inbound_guard BEFORE INSERT OR DELETE OR UPDATE ON semantic.inbound_link FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_epoch_mapping_links();


--
-- Name: outbound_link identity_epoch_mapping_outbound_guard; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_mapping_outbound_guard BEFORE INSERT OR DELETE OR UPDATE ON semantic.outbound_link FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_epoch_mapping_links();


--
-- Name: identity_epoch_mapping_payload identity_epoch_mapping_payload_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_payload_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_payload DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: identity_epoch_mapping_plan identity_epoch_mapping_plan_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_plan_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_plan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: identity_epoch_mapping_plan identity_epoch_mapping_plan_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_mapping_plan_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_mapping_plan FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_mapping_undo identity_epoch_mapping_undo_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_undo_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_undo DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: identity_epoch_mapping_undo identity_epoch_mapping_undo_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_mapping_undo_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_mapping_undo FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_mapping_withdrawal identity_epoch_mapping_withdrawal_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_mapping_withdrawal_erasure AFTER INSERT OR UPDATE ON semantic.identity_epoch_mapping_withdrawal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_mapping_state_erasure();


--
-- Name: identity_epoch_mapping_withdrawal identity_epoch_mapping_withdrawal_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_mapping_withdrawal_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_mapping_withdrawal FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_native_commit identity_epoch_native_commit_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_native_commit_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_native_commit FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_prearm_bridge identity_epoch_prearm_bridge_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_bridge_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_bridge DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_claim identity_epoch_prearm_claim_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_claim_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_claim DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_claim identity_epoch_prearm_claim_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_claim_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_prearm_claim FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_prearm_custody identity_epoch_prearm_custody_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_custody_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_custody identity_epoch_prearm_custody_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_custody_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_prearm_custody FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_prearm_decision identity_epoch_prearm_decision_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_decision_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_decision identity_epoch_prearm_decision_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_decision_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_prearm_decision FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_prearm_directory identity_epoch_prearm_directory_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_directory_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_directory DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_disposition identity_epoch_prearm_disposition_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_disposition_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_disposition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_disposition identity_epoch_prearm_disposition_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_disposition_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_prearm_disposition FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_group identity_epoch_prearm_group_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_group_gate BEFORE DELETE OR UPDATE ON semantic.identity_epoch_group FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_group();


--
-- Name: identity_epoch_prearm_inverse identity_epoch_prearm_inverse_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_inverse_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_inverse DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_inverse identity_epoch_prearm_inverse_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_inverse_gate BEFORE INSERT OR DELETE OR UPDATE ON semantic.identity_epoch_prearm_inverse FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_inverse();


--
-- Name: identity_epoch_original identity_epoch_prearm_membership_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_membership_gate BEFORE INSERT OR DELETE OR UPDATE ON semantic.identity_epoch_original FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_membership();


--
-- Name: identity_epoch_prearm_page identity_epoch_prearm_page_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_prearm_page_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_prearm_page DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_prearm_erasure();


--
-- Name: identity_epoch_prearm_page identity_epoch_prearm_page_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_prearm_page_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_prearm_page FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_prearm_page();


--
-- Name: identity_epoch_receipt_binding identity_epoch_receipt_binding_stable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receipt_binding_stable BEFORE UPDATE ON semantic.identity_epoch_receipt_binding FOR EACH ROW EXECUTE FUNCTION semantic.keep_identity_epoch_accepted_binding();


--
-- Name: identity_epoch_receipt_claim_commit identity_epoch_receipt_claim_commit_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receipt_claim_commit_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_receipt_claim_commit FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_receipt_claim identity_epoch_receipt_claim_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receipt_claim_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_receipt_claim FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_receipt_closure identity_epoch_receipt_closure_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receipt_closure_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_receipt_closure FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_receiving_custody identity_epoch_receiving_custody_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_receiving_custody_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();


--
-- Name: identity_epoch_receiving_custody identity_epoch_receiving_custody_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receiving_custody_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_receiving_custody FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_receiving_effect identity_epoch_receiving_effect_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_receiving_effect_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();


--
-- Name: identity_epoch_receiving_effect identity_epoch_receiving_effect_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receiving_effect_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_receiving_effect FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_receiving_plan identity_epoch_receiving_plan_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_receiving_plan_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_plan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();


--
-- Name: identity_epoch_receiving_plan identity_epoch_receiving_plan_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receiving_plan_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_receiving_plan FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_receiving_record identity_epoch_receiving_record_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_receiving_record_erasure_capture AFTER INSERT ON semantic.identity_epoch_receiving_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_receiving_erasure();


--
-- Name: identity_epoch_receiving_record identity_epoch_receiving_record_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_receiving_record_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_receiving_record FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_source_consumer_custody identity_epoch_source_consumer_custody_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_source_consumer_custody_erasure_capture AFTER INSERT ON semantic.identity_epoch_source_consumer_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_source_consumer_custody_erasure();


--
-- Name: identity_epoch_source_consumer_custody identity_epoch_source_consumer_custody_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_source_consumer_custody_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_source_consumer_custody FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_source_consumer_custody identity_epoch_source_consumer_custody_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_source_consumer_custody_no_truncate BEFORE TRUNCATE ON semantic.identity_epoch_source_consumer_custody FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consumer_terminal_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_source_consumer_terminal_erasure_capture AFTER INSERT ON semantic.identity_epoch_source_consumer_terminal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_source_consumer_custody_erasure();


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consumer_terminal_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_source_consumer_terminal_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_source_consumer_terminal FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consumer_terminal_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_source_consumer_terminal_no_truncate BEFORE TRUNCATE ON semantic.identity_epoch_source_consumer_terminal FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_step identity_epoch_step_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_epoch_step_erasure_capture AFTER INSERT OR UPDATE ON semantic.identity_epoch_step DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_step_erasure();


--
-- Name: identity_epoch_step identity_epoch_step_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_step_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_step FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_prearm_page identity_prearm_release_fence; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_prearm_release_fence AFTER INSERT OR DELETE OR UPDATE ON semantic.identity_epoch_prearm_page FOR EACH ROW EXECUTE FUNCTION semantic.invalidate_identity_prearm_release();


--
-- Name: identity_public_output_accepted identity_public_output_accepted_binding; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_accepted_binding AFTER INSERT ON semantic.identity_public_output_accepted DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_accepted_binding();


--
-- Name: identity_public_output_accepted identity_public_output_accepted_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_accepted_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_accepted FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_accepted identity_public_output_accepted_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_accepted_native AFTER INSERT ON semantic.identity_public_output_accepted DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_accepted identity_public_output_accepted_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_accepted_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_accepted FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_consumer identity_public_output_consumer_count; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_consumer_count AFTER INSERT ON semantic.identity_public_output_consumer FOR EACH ROW EXECUTE FUNCTION semantic.enroll_public_output_consumer();


--
-- Name: identity_public_output_consumer identity_public_output_consumer_fresh; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_consumer_fresh BEFORE INSERT ON semantic.identity_public_output_consumer FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_fresh_write();


--
-- Name: identity_public_output_consumer identity_public_output_consumer_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_consumer_gate BEFORE INSERT ON semantic.identity_public_output_consumer FOR EACH ROW EXECUTE FUNCTION semantic.enroll_public_output_consumer();


--
-- Name: identity_public_output_consumer identity_public_output_consumer_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_consumer_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_consumer FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_consumer identity_public_output_consumer_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_consumer_native AFTER INSERT ON semantic.identity_public_output_consumer DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_consumer identity_public_output_consumer_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_consumer_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_consumer FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_disposition identity_public_output_disposition_atomic; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_disposition_atomic AFTER INSERT ON semantic.identity_public_output_disposition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_transition();


--
-- Name: identity_public_output_disposition identity_public_output_disposition_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_disposition_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_disposition FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_disposition identity_public_output_disposition_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_disposition_native AFTER INSERT ON semantic.identity_public_output_disposition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_disposition identity_public_output_disposition_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_disposition_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_disposition FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_fence identity_public_output_fence_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_fence_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_fence FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_fence identity_public_output_fence_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_fence_native AFTER INSERT ON semantic.identity_public_output_fence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_fence identity_public_output_fence_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_fence_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_fence FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_gate identity_public_output_gate_closed; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_gate_closed AFTER UPDATE ON semantic.identity_public_output_gate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_gate_close();


--
-- Name: identity_public_output_gate identity_public_output_gate_monotone; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_gate_monotone BEFORE DELETE OR UPDATE ON semantic.identity_public_output_gate FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_gate();


--
-- Name: identity_public_output_gate identity_public_output_gate_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_gate_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_gate FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_gate identity_public_output_gate_origin; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_gate_origin AFTER INSERT ON semantic.identity_public_output_gate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_gate_origin();


--
-- Name: identity_public_output_member identity_public_output_member_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_member_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_member FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_member identity_public_output_member_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_member_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_member FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_original identity_public_output_original_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_original_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_original FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_original identity_public_output_original_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_original_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_original FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_page identity_public_output_page_fresh; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_page_fresh BEFORE INSERT ON semantic.identity_public_output_page FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_fresh_write();


--
-- Name: identity_public_output_page identity_public_output_page_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_page_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_page FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_page identity_public_output_page_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_page_native AFTER INSERT ON semantic.identity_public_output_page DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_page identity_public_output_page_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_page_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_page FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_progress identity_public_output_progress_monotone; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_progress_monotone BEFORE DELETE OR UPDATE ON semantic.identity_public_output_progress FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_progress();


--
-- Name: identity_public_output_progress identity_public_output_progress_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_progress_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_progress FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_seal identity_public_output_seal_fresh; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_seal_fresh BEFORE INSERT ON semantic.identity_public_output_seal FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_fresh_write();


--
-- Name: identity_public_output_seal identity_public_output_seal_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_seal_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_seal FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_seal identity_public_output_seal_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_seal_native AFTER INSERT ON semantic.identity_public_output_seal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_seal identity_public_output_seal_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_seal_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_seal FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_stage identity_public_output_stage_atomic; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_stage_atomic AFTER INSERT ON semantic.identity_public_output_stage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_transition();


--
-- Name: identity_public_output_stage identity_public_output_stage_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_stage_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_stage FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_stage identity_public_output_stage_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_stage_native AFTER INSERT ON semantic.identity_public_output_stage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_stage identity_public_output_stage_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_stage_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_stage FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_subject_cut identity_public_output_subject_cut_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_subject_cut_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_subject_cut FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_subject_cut identity_public_output_subject_cut_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_subject_cut_native AFTER INSERT ON semantic.identity_public_output_subject_cut DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_subject_cut identity_public_output_subject_cut_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_subject_cut_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_subject_cut FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_subject_release identity_public_output_subject_release_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_subject_release_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_subject_release FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_subject_release identity_public_output_subject_release_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_subject_release_native AFTER INSERT ON semantic.identity_public_output_subject_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_subject_release identity_public_output_subject_release_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_subject_release_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_subject_release FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_subject_slot identity_public_output_subject_slot_monotone; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_subject_slot_monotone BEFORE DELETE OR UPDATE ON semantic.identity_public_output_subject_slot FOR EACH ROW EXECUTE FUNCTION semantic.guard_public_output_slot();


--
-- Name: identity_public_output_subject_slot identity_public_output_subject_slot_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_subject_slot_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_subject_slot FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_transition identity_public_output_transition_atomic; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_transition_atomic AFTER INSERT ON semantic.identity_public_output_transition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_transition();


--
-- Name: identity_public_output_transition identity_public_output_transition_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_transition_immutable BEFORE DELETE OR UPDATE ON semantic.identity_public_output_transition FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_public_output_transition identity_public_output_transition_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_public_output_transition_native AFTER INSERT ON semantic.identity_public_output_transition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_output_native();


--
-- Name: identity_public_output_transition identity_public_output_transition_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_output_transition_no_truncate BEFORE TRUNCATE ON semantic.identity_public_output_transition FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: subject identity_public_writer; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_public_writer AFTER INSERT OR DELETE OR UPDATE ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_public_writer();


--
-- Name: identity_epoch_effect_receipt identity_receiving_capture_budget; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT OR UPDATE ON semantic.identity_epoch_effect_receipt FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();


--
-- Name: identity_epoch_receiving_custody identity_receiving_capture_budget; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_custody FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();


--
-- Name: identity_epoch_receiving_effect identity_receiving_capture_budget; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_effect FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();


--
-- Name: identity_epoch_receiving_plan identity_receiving_capture_budget; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_plan FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();


--
-- Name: identity_epoch_receiving_record identity_receiving_capture_budget; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT ON semantic.identity_epoch_receiving_record FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();


--
-- Name: identity_epoch_step identity_receiving_capture_budget; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_receiving_capture_budget AFTER INSERT OR UPDATE ON semantic.identity_epoch_step FOR EACH ROW EXECUTE FUNCTION semantic.enqueue_identity_receiving_capture();


--
-- Name: identity_epoch_receiving_plan identity_receiving_scope_pending; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_receiving_scope_pending AFTER INSERT ON semantic.identity_epoch_receiving_plan FOR EACH ROW EXECUTE FUNCTION search.enqueue_identity_receiving_scope();


--
-- Name: identity_epoch_group identity_scope_claim; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_claim BEFORE UPDATE OF pending_job, pending_epoch ON semantic.identity_epoch_group FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_claim();


--
-- Name: identity_scope_attempt identity_scope_consumer_attempt_guard; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_consumer_attempt_guard BEFORE INSERT OR DELETE OR UPDATE ON semantic.identity_scope_attempt FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();


--
-- Name: identity_scope_completion identity_scope_consumer_completion_guard; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_consumer_completion_guard BEFORE INSERT OR DELETE OR UPDATE ON semantic.identity_scope_completion FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();


--
-- Name: identity_scope_consumer_fence identity_scope_consumer_fence_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_consumer_fence_immutable BEFORE DELETE OR UPDATE ON semantic.identity_scope_consumer_fence FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_scope_consumer_fence identity_scope_consumer_fence_native; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER identity_scope_consumer_fence_native AFTER INSERT ON semantic.identity_scope_consumer_fence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_identity_scope_consumer_fence();


--
-- Name: identity_scope_consumer_fence identity_scope_consumer_fence_no_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_consumer_fence_no_truncate BEFORE TRUNCATE ON semantic.identity_scope_consumer_fence FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_scope_forward identity_scope_consumer_forward_guard; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_consumer_forward_guard BEFORE INSERT OR DELETE OR UPDATE ON semantic.identity_scope_forward FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();


--
-- Name: identity_scope_prearm_receipt identity_scope_consumer_prearm_guard; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_consumer_prearm_guard BEFORE INSERT OR DELETE OR UPDATE ON semantic.identity_scope_prearm_receipt FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();


--
-- Name: identity_scope_summary identity_scope_consumer_summary_guard; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_scope_consumer_summary_guard BEFORE INSERT OR DELETE OR UPDATE ON semantic.identity_scope_summary FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_consumer_writer();


--
-- Name: identity_epoch_source_consumer_terminal identity_source_consumer_binding_fence; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_source_consumer_binding_fence AFTER INSERT ON semantic.identity_epoch_source_consumer_terminal FOR EACH ROW EXECUTE FUNCTION semantic.bind_identity_source_consumer_terminal();


--
-- Name: kind_type_evidence_body immutable_kind_type_evidence_body; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER immutable_kind_type_evidence_body BEFORE UPDATE ON semantic.kind_type_evidence_body FOR EACH ROW EXECUTE FUNCTION semantic.immutable_kind_type_evidence_body();


--
-- Name: inbound_link inbound_copy_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER inbound_copy_erasure BEFORE INSERT OR UPDATE ON semantic.inbound_link FOR EACH ROW EXECUTE FUNCTION semantic.capture_copy_erasure();


--
-- Name: inbound_link inbound_link_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER inbound_link_erasure_capture AFTER INSERT OR UPDATE ON semantic.inbound_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_inbound_link_erasure();


--
-- Name: account_agent_subject kind_type_agent_link_fence; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER kind_type_agent_link_fence BEFORE INSERT OR DELETE OR UPDATE ON semantic.account_agent_subject FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();


--
-- Name: redirect kind_type_redirect_fence; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER kind_type_redirect_fence BEFORE INSERT OR DELETE OR UPDATE ON semantic.redirect FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();


--
-- Name: revision kind_type_revision_fence; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER kind_type_revision_fence BEFORE INSERT OR DELETE OR UPDATE ON semantic.revision FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();


--
-- Name: subject kind_type_subject_fence; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER kind_type_subject_fence BEFORE INSERT OR DELETE OR UPDATE ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();


--
-- Name: moderation moderation_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER moderation_erasure_capture AFTER INSERT OR UPDATE ON semantic.moderation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_moderation_erasure();


--
-- Name: moderation moderation_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER moderation_immutable BEFORE DELETE OR UPDATE ON semantic.moderation FOR EACH ROW EXECUTE FUNCTION semantic.prevent_moderation_mutation();


--
-- Name: moderation moderation_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER moderation_immutable_truncate BEFORE TRUNCATE ON semantic.moderation FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_moderation_mutation();


--
-- Name: outbound_link outbound_copy_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER outbound_copy_erasure BEFORE INSERT OR UPDATE ON semantic.outbound_link FOR EACH ROW EXECUTE FUNCTION semantic.capture_copy_erasure();


--
-- Name: outbound_link outbound_link_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER outbound_link_erasure_capture AFTER INSERT OR UPDATE ON semantic.outbound_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_outbound_link_erasure();


--
-- Name: source_candidate provider_review_queue_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER provider_review_queue_capture AFTER INSERT OR UPDATE ON semantic.source_candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_provider_review_queue_key();


--
-- Name: public_filter_bootstrap public_filter_bootstrap_baseline_seal; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_bootstrap_baseline_seal BEFORE UPDATE ON semantic.public_filter_bootstrap FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_baseline_seal();


--
-- Name: public_filter_read_definition public_filter_definition_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_definition_immutable BEFORE UPDATE ON semantic.public_filter_read_definition FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_definition();


--
-- Name: public_filter_privacy_pending public_filter_enrollment_window_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_enrollment_window_immutable BEFORE UPDATE ON semantic.public_filter_privacy_pending FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_enrollment_window();


--
-- Name: public_filter_home_enrollment public_filter_home_creation_pin; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_home_creation_pin BEFORE INSERT OR UPDATE ON semantic.public_filter_home_enrollment FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_filter_creation_pin();


--
-- Name: public_filter_home_enrollment public_filter_home_receipt_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_home_receipt_immutable BEFORE UPDATE ON semantic.public_filter_home_enrollment FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_home_receipt();


--
-- Name: public_filter_key_enrollment public_filter_key_generation_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_key_generation_immutable BEFORE UPDATE ON semantic.public_filter_key_enrollment FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_key_generation();


--
-- Name: public_filter_population_start public_filter_population_start_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_population_start_immutable BEFORE DELETE OR UPDATE ON semantic.public_filter_population_start FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_population_start();


--
-- Name: public_filter_repair_step public_filter_repair_ack_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_repair_ack_immutable BEFORE UPDATE ON semantic.public_filter_repair_step FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_repair_ack();


--
-- Name: public_filter_repair_advance public_filter_repair_advance_commit; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER public_filter_repair_advance_commit AFTER INSERT ON semantic.public_filter_repair_advance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_public_filter_repair_advance();


--
-- Name: public_filter_repair_advance public_filter_repair_advance_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_repair_advance_immutable BEFORE DELETE OR UPDATE ON semantic.public_filter_repair_advance FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: public_filter_repair_step public_filter_repair_step_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER public_filter_repair_step_immutable BEFORE DELETE OR UPDATE ON semantic.public_filter_repair_step FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_repair_verification();


--
-- Name: record_lifecycle record_lifecycle_native_commit; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_lifecycle_native_commit AFTER INSERT OR UPDATE ON semantic.record_lifecycle DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_record_deletion_commit();


--
-- Name: record_lifecycle record_lifecycle_retention; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER record_lifecycle_retention AFTER INSERT OR UPDATE ON semantic.record_lifecycle FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_retention();


--
-- Name: record_purge_command record_purge_command_commit; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_purge_command_commit AFTER INSERT ON semantic.record_purge_command DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_command_commit();


--
-- Name: record_purge_hold record_purge_hold_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER record_purge_hold_immutable BEFORE DELETE OR UPDATE ON semantic.record_purge_hold FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_hold_immutable();


--
-- Name: record_purge_receiving record_purge_receiving_completion; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_purge_receiving_completion AFTER UPDATE ON semantic.record_purge_receiving DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_receiving_completion();


--
-- Name: record_purge_receiving record_purge_receiving_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER record_purge_receiving_immutable BEFORE DELETE OR UPDATE ON semantic.record_purge_receiving FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_receiving_immutable();


--
-- Name: record_retention_commit record_retention_commit_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER record_retention_commit_immutable BEFORE DELETE OR UPDATE ON semantic.record_retention_commit FOR EACH ROW EXECUTE FUNCTION semantic.protect_record_retention_commit();


--
-- Name: candidate record_source_candidate_member; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_source_candidate_member AFTER INSERT ON semantic.candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.require_record_source_member();


--
-- Name: fact record_source_fact_member; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_source_fact_member AFTER INSERT ON semantic.fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.require_record_source_member();


--
-- Name: record_source_set record_source_set_commit; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_source_set_commit AFTER INSERT ON semantic.record_source_set DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.commit_record_source_set();


--
-- Name: record_source_set record_source_set_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_source_set_erasure AFTER INSERT ON semantic.record_source_set DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_source_set_erasure();


--
-- Name: record_source_set record_source_set_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER record_source_set_immutable BEFORE DELETE OR UPDATE ON semantic.record_source_set FOR EACH ROW EXECUTE FUNCTION semantic.guard_record_source_set();


--
-- Name: record_source_set_member record_source_set_member_erasure; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER record_source_set_member_erasure AFTER INSERT ON semantic.record_source_set_member DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_source_set_erasure();


--
-- Name: record_source_set_member record_source_set_member_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER record_source_set_member_immutable BEFORE INSERT OR DELETE OR UPDATE ON semantic.record_source_set_member FOR EACH ROW EXECUTE FUNCTION semantic.guard_record_source_set();


--
-- Name: redirect redirect_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER redirect_erasure_capture AFTER INSERT OR UPDATE ON semantic.redirect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_redirect_erasure();


--
-- Name: redirect redirect_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER redirect_immutable BEFORE DELETE OR UPDATE ON semantic.redirect FOR EACH ROW EXECUTE FUNCTION semantic.prevent_redirect_mutation();


--
-- Name: release_composite release_composite_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER release_composite_erasure_capture AFTER INSERT OR UPDATE ON semantic.release_composite DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_release_composite_erasure();


--
-- Name: resource_record_purge_commit resource_record_purge_commit_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER resource_record_purge_commit_immutable BEFORE DELETE OR UPDATE ON semantic.resource_record_purge_commit FOR EACH ROW EXECUTE FUNCTION semantic.protect_record_retention_commit();


--
-- Name: retraction retraction_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER retraction_erasure_capture AFTER INSERT OR UPDATE ON semantic.retraction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_retraction_erasure();


--
-- Name: retraction retraction_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER retraction_immutable BEFORE DELETE OR UPDATE ON semantic.retraction FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: retraction retraction_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER retraction_immutable_truncate BEFORE TRUNCATE ON semantic.retraction FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: revision revision_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER revision_erasure_capture AFTER INSERT OR UPDATE ON semantic.revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_revision_erasure();


--
-- Name: revision revision_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER revision_immutable BEFORE DELETE OR UPDATE ON semantic.revision FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: revision revision_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER revision_immutable_truncate BEFORE TRUNCATE ON semantic.revision FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: adoption search_project_adoption; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER search_project_adoption AFTER INSERT ON semantic.adoption FOR EACH ROW WHEN ((new.context_id = '00000000-0000-8000-8000-000000000000'::uuid)) EXECUTE FUNCTION semantic.search_project_insert('adoption');


--
-- Name: fact search_project_fact; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER search_project_fact AFTER INSERT ON semantic.fact FOR EACH ROW WHEN ((new.kind = 'statement'::text)) EXECUTE FUNCTION semantic.search_project_insert('fact');


--
-- Name: subject search_project_subject; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER search_project_subject AFTER INSERT ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.search_project_subject();


--
-- Name: source_candidate source_candidate_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER source_candidate_erasure_capture AFTER INSERT OR UPDATE ON semantic.source_candidate DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_source_candidate_erasure();


--
-- Name: statement_disclosure statement_disclosure_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER statement_disclosure_erasure_capture AFTER INSERT OR UPDATE ON semantic.statement_disclosure DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_statement_disclosure_erasure();


--
-- Name: subject subject_erasure_capture; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE CONSTRAINT TRIGGER subject_erasure_capture AFTER INSERT OR UPDATE ON semantic.subject DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_subject_erasure();


--
-- Name: partition_subjects subject_page_bootstrap_population; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_page_bootstrap_population AFTER INSERT OR UPDATE OF visible ON semantic.partition_subjects FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_bootstrap_population();


--
-- Name: subject_page_bootstrap subject_page_bootstrap_work_home; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_page_bootstrap_work_home AFTER INSERT OR UPDATE OF state ON semantic.subject_page_bootstrap FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_work_home_changed();


--
-- Name: subject_page_change subject_page_change_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_page_change_immutable BEFORE DELETE OR UPDATE ON semantic.subject_page_change FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: subject_page_fanout subject_page_fanout_work_home; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_page_fanout_work_home AFTER INSERT OR UPDATE OF state ON semantic.subject_page_fanout FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_work_home_changed();


--
-- Name: subject_page_repair subject_page_repair_work_home; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_page_repair_work_home AFTER INSERT OR UPDATE OF state ON semantic.subject_page_repair FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_work_home_changed();


--
-- Name: subject subject_record_purge_gate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_record_purge_gate BEFORE DELETE OR UPDATE ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: subject subject_security_revision; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_security_revision BEFORE UPDATE ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.guard_subject_security();


--
-- Name: acceptance_current acceptance_current_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: acceptance_current acceptance_current_route_subject_id_context_id_candidate_i_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_route_subject_id_context_id_candidate_i_fkey FOREIGN KEY (route, subject_id, context_id, candidate_id, head) REFERENCES semantic.acceptance(route, subject_id, context_id, candidate_id, head);


--
-- Name: acceptance_current acceptance_current_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: acceptance acceptance_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: acceptance acceptance_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: acceptance acceptance_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: adoption adoption_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.adoption
    ADD CONSTRAINT adoption_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: adoption adoption_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.adoption
    ADD CONSTRAINT adoption_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: candidate candidate_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.candidate
    ADD CONSTRAINT candidate_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: candidate candidate_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.candidate
    ADD CONSTRAINT candidate_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: context_extension_activation context_extension_activation_route_context_id_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_extension_activation
    ADD CONSTRAINT context_extension_activation_route_context_id_digest_fkey FOREIGN KEY (route, context_id, digest) REFERENCES semantic.context_extension(route, context_id, digest);


--
-- Name: context_role_enrollment context_role_enrollment_context_key_route_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_role_enrollment
    ADD CONSTRAINT context_role_enrollment_context_key_route_fkey FOREIGN KEY (context_key, route) REFERENCES semantic.context(erasure_key, route) ON DELETE CASCADE;


--
-- Name: definition_activation definition_activation_route_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_activation
    ADD CONSTRAINT definition_activation_route_digest_fkey FOREIGN KEY (route, digest) REFERENCES semantic.definition_release(route, digest);


--
-- Name: definition_catalogue_activation definition_catalogue_activation_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_activation
    ADD CONSTRAINT definition_catalogue_activation_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_enrollment(route, root_digest);


--
-- Name: definition_catalogue_checkpoint definition_catalogue_checkpoint_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_checkpoint
    ADD CONSTRAINT definition_catalogue_checkpoint_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_enrollment(route, root_digest);


--
-- Name: definition_catalogue_consumer definition_catalogue_consumer_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_consumer
    ADD CONSTRAINT definition_catalogue_consumer_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_enrollment(route, root_digest);


--
-- Name: definition_catalogue_consumer definition_catalogue_consumer_route_root_digest_invalidate_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_consumer
    ADD CONSTRAINT definition_catalogue_consumer_route_root_digest_invalidate_fkey FOREIGN KEY (route, root_digest, invalidated_generation) REFERENCES semantic.definition_catalogue_enrollment(route, root_digest, closed_generation);


--
-- Name: definition_catalogue_enrollment definition_catalogue_enrollment_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_enrollment
    ADD CONSTRAINT definition_catalogue_enrollment_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_build(route, root_digest);


--
-- Name: definition_catalogue_frontier definition_catalogue_frontier_route_consumer_root_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_frontier
    ADD CONSTRAINT definition_catalogue_frontier_route_consumer_root_fkey FOREIGN KEY (route, consumer_root) REFERENCES semantic.definition_catalogue_enrollment(route, root_digest);


--
-- Name: definition_catalogue_frontier definition_catalogue_frontier_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_frontier
    ADD CONSTRAINT definition_catalogue_frontier_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_activation(route, root_digest);


--
-- Name: definition_catalogue_label definition_catalogue_label_route_root_digest_ordinal_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_label
    ADD CONSTRAINT definition_catalogue_label_route_root_digest_ordinal_fkey FOREIGN KEY (route, root_digest, ordinal) REFERENCES semantic.definition_catalogue_kind(route, root_digest, ordinal);


--
-- Name: definition_catalogue_position definition_catalogue_position_route_original_key_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_position
    ADD CONSTRAINT definition_catalogue_position_route_original_key_fkey FOREIGN KEY (route, original_key) REFERENCES semantic.definition_catalogue_original(route, original_key);


--
-- Name: definition_catalogue_position definition_catalogue_position_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_position
    ADD CONSTRAINT definition_catalogue_position_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_enrollment(route, root_digest);


--
-- Name: definition_catalogue_retirement definition_catalogue_retirement_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_retirement
    ADD CONSTRAINT definition_catalogue_retirement_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_enrollment(route, root_digest);


--
-- Name: definition_catalogue_task definition_catalogue_task_route_root_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_task
    ADD CONSTRAINT definition_catalogue_task_route_root_digest_fkey FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_build(route, root_digest);


--
-- Name: definition_catalogue_ticket definition_catalogue_ticket_route_original_key_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_catalogue_ticket
    ADD CONSTRAINT definition_catalogue_ticket_route_original_key_fkey FOREIGN KEY (route, original_key) REFERENCES semantic.definition_catalogue_original(route, original_key);


--
-- Name: erasure_progress erasure_progress_route_account_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.erasure_progress
    ADD CONSTRAINT erasure_progress_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: external_claim external_claim_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.external_claim
    ADD CONSTRAINT external_claim_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: facet_population_frontier facet_population_frontier_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.facet_population_frontier
    ADD CONSTRAINT facet_population_frontier_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: facet_population_frontier facet_population_frontier_partition_no_predecessor_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.facet_population_frontier
    ADD CONSTRAINT facet_population_frontier_partition_no_predecessor_fkey FOREIGN KEY (partition_no, predecessor) REFERENCES semantic.facet_population_frontier(partition_no, frontier);


--
-- Name: fact fact_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.fact
    ADD CONSTRAINT fact_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: hidden_candidate hidden_candidate_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.hidden_candidate
    ADD CONSTRAINT hidden_candidate_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: identity_epoch_receipt_binding identity_binding_consumer_undo_commit; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_binding
    ADD CONSTRAINT identity_binding_consumer_undo_commit FOREIGN KEY (partition_no, consumer_undo_transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_ack identity_epoch_ack_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_ack
    ADD CONSTRAINT identity_epoch_ack_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_admission_plan identity_epoch_admission_plan_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_plan
    ADD CONSTRAINT identity_epoch_admission_plan_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_admission_receipt identity_epoch_admission_rece_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_receipt
    ADD CONSTRAINT identity_epoch_admission_rece_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position");


--
-- Name: identity_epoch_admission_source_hold identity_epoch_admission_sourc_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_source_hold
    ADD CONSTRAINT identity_epoch_admission_sourc_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_admission_source identity_epoch_admission_source_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_source
    ADD CONSTRAINT identity_epoch_admission_source_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_admission_validation identity_epoch_admission_validation_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_validation
    ADD CONSTRAINT identity_epoch_admission_validation_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_bootstrap_basis identity_epoch_bootstrap_basi_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_basis
    ADD CONSTRAINT identity_epoch_bootstrap_basi_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position");


--
-- Name: identity_epoch_bootstrap_page identity_epoch_bootstrap_page_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_page
    ADD CONSTRAINT identity_epoch_bootstrap_page_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_bootstrap_row identity_epoch_bootstrap_row_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_row
    ADD CONSTRAINT identity_epoch_bootstrap_row_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_bootstrap_page(partition_no, transaction_id);


--
-- Name: identity_epoch_change identity_epoch_change_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_change
    ADD CONSTRAINT identity_epoch_change_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_effect_receipt identity_epoch_effect_receipt_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_effect_receipt
    ADD CONSTRAINT identity_epoch_effect_receipt_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_input identity_epoch_input_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_input
    ADD CONSTRAINT identity_epoch_input_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_installation identity_epoch_installation_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_installation
    ADD CONSTRAINT identity_epoch_installation_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES semantic.identity_epoch_installation_cut(partition_no);


--
-- Name: identity_epoch_installation identity_epoch_installation_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_installation
    ADD CONSTRAINT identity_epoch_installation_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_mapping_effect identity_epoch_mapping_effect_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_effect
    ADD CONSTRAINT identity_epoch_mapping_effect_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_epoch_mapping_fence identity_epoch_mapping_fence_route_destination_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_fence
    ADD CONSTRAINT identity_epoch_mapping_fence_route_destination_fkey FOREIGN KEY (route, destination) REFERENCES semantic.subject(route, subject_id);


--
-- Name: identity_epoch_mapping_head identity_epoch_mapping_head_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_head
    ADD CONSTRAINT identity_epoch_mapping_head_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_mapping_payload identity_epoch_mapping_payload_partition_no_job_id_unit_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_payload
    ADD CONSTRAINT identity_epoch_mapping_payload_partition_no_job_id_unit_fkey FOREIGN KEY (partition_no, job_id, unit) REFERENCES semantic.identity_epoch_mapping_effect(partition_no, job_id, unit);


--
-- Name: identity_epoch_mapping_plan identity_epoch_mapping_plan_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_plan
    ADD CONSTRAINT identity_epoch_mapping_plan_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_mapping identity_epoch_mapping_route_original_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping
    ADD CONSTRAINT identity_epoch_mapping_route_original_fkey FOREIGN KEY (route, original) REFERENCES semantic.subject(route, subject_id);


--
-- Name: identity_epoch_mapping_undo identity_epoch_mapping_undo_partition_no_job_id_unit_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_undo
    ADD CONSTRAINT identity_epoch_mapping_undo_partition_no_job_id_unit_fkey FOREIGN KEY (partition_no, job_id, unit) REFERENCES semantic.identity_epoch_mapping_effect(partition_no, job_id, unit);


--
-- Name: identity_epoch_mapping_undo identity_epoch_mapping_undo_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_undo
    ADD CONSTRAINT identity_epoch_mapping_undo_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_epoch_mapping_withdrawal identity_epoch_mapping_withdra_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_withdrawal
    ADD CONSTRAINT identity_epoch_mapping_withdra_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_epoch_mapping_withdrawal identity_epoch_mapping_withdrawal_partition_no_job_id_unit_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping_withdrawal
    ADD CONSTRAINT identity_epoch_mapping_withdrawal_partition_no_job_id_unit_fkey FOREIGN KEY (partition_no, job_id, unit) REFERENCES semantic.identity_epoch_mapping_effect(partition_no, job_id, unit);


--
-- Name: identity_epoch_prearm_claim identity_epoch_prearm_claim_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_claim
    ADD CONSTRAINT identity_epoch_prearm_claim_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_prearm_custody identity_epoch_prearm_custody_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_custody
    ADD CONSTRAINT identity_epoch_prearm_custody_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_prearm_custody identity_epoch_prearm_custody_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_custody
    ADD CONSTRAINT identity_epoch_prearm_custody_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_prearm_decision identity_epoch_prearm_decision_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_decision
    ADD CONSTRAINT identity_epoch_prearm_decision_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_prearm_directory identity_epoch_prearm_directo_partition_no_attempt_transac_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_directory
    ADD CONSTRAINT identity_epoch_prearm_directo_partition_no_attempt_transac_fkey FOREIGN KEY (partition_no, attempt_transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_prearm_disposition identity_epoch_prearm_disposit_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_disposition
    ADD CONSTRAINT identity_epoch_prearm_disposit_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_prearm_disposition identity_epoch_prearm_disposition_partition_no_page_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_disposition
    ADD CONSTRAINT identity_epoch_prearm_disposition_partition_no_page_id_fkey FOREIGN KEY (partition_no, page_id) REFERENCES semantic.identity_epoch_prearm_page(partition_no, page_id);


--
-- Name: identity_epoch_prearm_inverse identity_epoch_prearm_inverse_partition_no_generation_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_inverse
    ADD CONSTRAINT identity_epoch_prearm_inverse_partition_no_generation_fkey FOREIGN KEY (partition_no, generation) REFERENCES semantic.identity_epoch_prearm_bridge(partition_no, generation);


--
-- Name: identity_epoch_prearm_inverse identity_epoch_prearm_inverse_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_inverse
    ADD CONSTRAINT identity_epoch_prearm_inverse_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_prearm_page identity_epoch_prearm_page_partition_no_job_id_generation_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_page
    ADD CONSTRAINT identity_epoch_prearm_page_partition_no_job_id_generation_fkey FOREIGN KEY (partition_no, job_id, generation) REFERENCES semantic.identity_epoch_prearm_directory(partition_no, job_id, generation);


--
-- Name: identity_epoch_prearm_page identity_epoch_prearm_page_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_page
    ADD CONSTRAINT identity_epoch_prearm_page_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_receipt_claim_commit identity_epoch_receipt_claim__partition_no_receipt_key_gen_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_claim_commit
    ADD CONSTRAINT identity_epoch_receipt_claim__partition_no_receipt_key_gen_fkey FOREIGN KEY (partition_no, receipt_key, generation) REFERENCES semantic.identity_epoch_receipt_claim(partition_no, receipt_key, generation);


--
-- Name: identity_epoch_receipt_claim_commit identity_epoch_receipt_claim_c_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_claim_commit
    ADD CONSTRAINT identity_epoch_receipt_claim_c_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_receipt_claim identity_epoch_receipt_claim_partition_no_receipt_key_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_claim
    ADD CONSTRAINT identity_epoch_receipt_claim_partition_no_receipt_key_fkey FOREIGN KEY (partition_no, receipt_key) REFERENCES semantic.identity_epoch_receipt_binding(partition_no, receipt_key);


--
-- Name: identity_epoch_receipt_closure identity_epoch_receipt_closur_partition_no_receipt_key_gen_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receipt_closure
    ADD CONSTRAINT identity_epoch_receipt_closur_partition_no_receipt_key_gen_fkey FOREIGN KEY (partition_no, receipt_key, generation) REFERENCES semantic.identity_epoch_receipt_claim(partition_no, receipt_key, generation);


--
-- Name: identity_epoch_receiving_custody identity_epoch_receiving_cust_partition_no_job_id_effect_k_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_custody
    ADD CONSTRAINT identity_epoch_receiving_cust_partition_no_job_id_effect_k_fkey FOREIGN KEY (partition_no, job_id, effect_key) REFERENCES semantic.identity_epoch_receiving_plan(partition_no, job_id, effect_key);


--
-- Name: identity_epoch_receiving_custody identity_epoch_receiving_custo_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_custody
    ADD CONSTRAINT identity_epoch_receiving_custo_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_receiving_effect identity_epoch_receiving_effe_partition_no_job_id_effect_k_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_effect
    ADD CONSTRAINT identity_epoch_receiving_effe_partition_no_job_id_effect_k_fkey FOREIGN KEY (partition_no, job_id, effect_key) REFERENCES semantic.identity_epoch_receiving_record(partition_no, job_id, effect_key);


--
-- Name: identity_epoch_receiving_effect identity_epoch_receiving_effec_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_effect
    ADD CONSTRAINT identity_epoch_receiving_effec_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_receiving_plan identity_epoch_receiving_plan_partition_no_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_plan
    ADD CONSTRAINT identity_epoch_receiving_plan_partition_no_job_id_fkey FOREIGN KEY (partition_no, job_id) REFERENCES semantic.identity_epoch_job(partition_no, job_id);


--
-- Name: identity_epoch_receiving_plan identity_epoch_receiving_plan_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_plan
    ADD CONSTRAINT identity_epoch_receiving_plan_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_receiving_record identity_epoch_receiving_reco_partition_no_owner_id_origin_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_record
    ADD CONSTRAINT identity_epoch_receiving_reco_partition_no_owner_id_origin_fkey FOREIGN KEY (partition_no, owner_id, original) REFERENCES semantic.identity_epoch_receiving_gate(partition_no, owner_id, original);


--
-- Name: identity_epoch_receiving_record identity_epoch_receiving_recor_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_record
    ADD CONSTRAINT identity_epoch_receiving_recor_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_receiving_search_progress identity_epoch_receiving_sear_partition_no_job_id_effect_k_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_search_progress
    ADD CONSTRAINT identity_epoch_receiving_sear_partition_no_job_id_effect_k_fkey FOREIGN KEY (partition_no, job_id, effect_key) REFERENCES semantic.identity_epoch_receiving_record(partition_no, job_id, effect_key) ON DELETE CASCADE;


--
-- Name: identity_epoch_receiving_search_progress identity_epoch_receiving_sear_partition_no_released_transa_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_receiving_search_progress
    ADD CONSTRAINT identity_epoch_receiving_sear_partition_no_released_transa_fkey FOREIGN KEY (partition_no, released_transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consume_partition_no_custody_key_pre_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_terminal
    ADD CONSTRAINT identity_epoch_source_consume_partition_no_custody_key_pre_fkey FOREIGN KEY (partition_no, custody_key, previous_sequence) REFERENCES semantic.identity_epoch_source_consumer_terminal(partition_no, custody_key, sequence);


--
-- Name: identity_epoch_source_consumer_custody identity_epoch_source_consume_partition_no_receipt_key_bin_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_custody
    ADD CONSTRAINT identity_epoch_source_consume_partition_no_receipt_key_bin_fkey FOREIGN KEY (partition_no, receipt_key, binding_generation) REFERENCES semantic.identity_epoch_receipt_claim(partition_no, receipt_key, generation);


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consume_partition_no_transaction_id_fkey1; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_terminal
    ADD CONSTRAINT identity_epoch_source_consume_partition_no_transaction_id_fkey1 FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.erasure_source_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_source_consumer_custody identity_epoch_source_consumer_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_custody
    ADD CONSTRAINT identity_epoch_source_consumer_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.erasure_source_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_source_consumer_terminal identity_epoch_source_consumer_te_partition_no_custody_key_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_source_consumer_terminal
    ADD CONSTRAINT identity_epoch_source_consumer_te_partition_no_custody_key_fkey FOREIGN KEY (partition_no, custody_key) REFERENCES semantic.identity_epoch_source_consumer_custody(partition_no, erasure_key);


--
-- Name: identity_epoch_step identity_epoch_step_partition_no_transaction_id_native_epo_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_step
    ADD CONSTRAINT identity_epoch_step_partition_no_transaction_id_native_epo_fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position");


--
-- Name: identity_epoch_prearm_directory identity_prearm_release_commit_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_prearm_directory
    ADD CONSTRAINT identity_prearm_release_commit_fkey FOREIGN KEY (partition_no, release_transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_public_output_accepted identity_public_output_accept_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_accepted
    ADD CONSTRAINT identity_public_output_accept_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_consumer identity_public_output_consum_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_consumer
    ADD CONSTRAINT identity_public_output_consum_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_disposition identity_public_output_dispos_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_disposition
    ADD CONSTRAINT identity_public_output_dispos_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_fence identity_public_output_fence_partition_no_transaction_id_n_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_fence
    ADD CONSTRAINT identity_public_output_fence_partition_no_transaction_id_n_fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_gate identity_public_output_gate_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_gate
    ADD CONSTRAINT identity_public_output_gate_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES semantic.identity_public_output_accepted(partition_no, capture_id);


--
-- Name: identity_public_output_page identity_public_output_page_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_page
    ADD CONSTRAINT identity_public_output_page_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES semantic.identity_public_output_accepted(partition_no, capture_id);


--
-- Name: identity_public_output_page identity_public_output_page_partition_no_transaction_id_na_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_page
    ADD CONSTRAINT identity_public_output_page_partition_no_transaction_id_na_fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_progress identity_public_output_progress_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_progress
    ADD CONSTRAINT identity_public_output_progress_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES semantic.identity_public_output_accepted(partition_no, capture_id);


--
-- Name: identity_public_output_seal identity_public_output_seal_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_seal
    ADD CONSTRAINT identity_public_output_seal_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES semantic.identity_public_output_accepted(partition_no, capture_id);


--
-- Name: identity_public_output_seal identity_public_output_seal_partition_no_transaction_id_na_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_seal
    ADD CONSTRAINT identity_public_output_seal_partition_no_transaction_id_na_fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_stage identity_public_output_stage_partition_no_capture_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_stage
    ADD CONSTRAINT identity_public_output_stage_partition_no_capture_id_fkey FOREIGN KEY (partition_no, capture_id) REFERENCES semantic.identity_public_output_accepted(partition_no, capture_id);


--
-- Name: identity_public_output_stage identity_public_output_stage_partition_no_transaction_id_n_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_stage
    ADD CONSTRAINT identity_public_output_stage_partition_no_transaction_id_n_fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_subject_release identity_public_output_subje_partition_no_transaction_id__fkey1; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_subject_release
    ADD CONSTRAINT identity_public_output_subje_partition_no_transaction_id__fkey1 FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_subject_cut identity_public_output_subjec_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_subject_cut
    ADD CONSTRAINT identity_public_output_subjec_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_public_output_transition identity_public_output_transi_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_public_output_transition
    ADD CONSTRAINT identity_public_output_transi_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: identity_scope_consumer_fence identity_scope_consumer_fence_partition_no_source_key_scop_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_consumer_fence
    ADD CONSTRAINT identity_scope_consumer_fence_partition_no_source_key_scop_fkey FOREIGN KEY (partition_no, source_key, scope_id) REFERENCES semantic.identity_scope_summary(partition_no, source_key, scope_id);


--
-- Name: identity_scope_consumer_fence identity_scope_consumer_fence_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_consumer_fence
    ADD CONSTRAINT identity_scope_consumer_fence_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position");


--
-- Name: identity_scope_native_association identity_scope_native_associat_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_scope_native_association
    ADD CONSTRAINT identity_scope_native_associat_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: merge_member merge_member_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.merge_member
    ADD CONSTRAINT merge_member_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: moderation moderation_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.moderation
    ADD CONSTRAINT moderation_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: moderation moderation_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.moderation
    ADD CONSTRAINT moderation_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: public_filter_bootstrap_account public_filter_bootstrap_account_partition_no_bootstrap_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_bootstrap_account
    ADD CONSTRAINT public_filter_bootstrap_account_partition_no_bootstrap_fkey FOREIGN KEY (partition_no, bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap);


--
-- Name: public_filter_bootstrap public_filter_bootstrap_partition_no_read_definition_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_bootstrap
    ADD CONSTRAINT public_filter_bootstrap_partition_no_read_definition_fkey FOREIGN KEY (partition_no, read_definition) REFERENCES semantic.public_filter_read_definition(partition_no, read_definition);


--
-- Name: public_filter_home_enrollment public_filter_enrollment_account_head; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_home_enrollment
    ADD CONSTRAINT public_filter_enrollment_account_head FOREIGN KEY (partition_no) REFERENCES access.account_discovery_population(partition_no);


--
-- Name: public_filter_home_enrollment public_filter_enrollment_source_head; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_home_enrollment
    ADD CONSTRAINT public_filter_enrollment_source_head FOREIGN KEY (partition_no) REFERENCES semantic.public_filter_privacy_head(partition_no);


--
-- Name: public_filter_home_enrollment public_filter_home_enrollment_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_home_enrollment
    ADD CONSTRAINT public_filter_home_enrollment_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: public_filter_key_enrollment public_filter_key_enrollment_partition_no_bootstrap_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_key_enrollment
    ADD CONSTRAINT public_filter_key_enrollment_partition_no_bootstrap_fkey FOREIGN KEY (partition_no, bootstrap) REFERENCES semantic.public_filter_home_enrollment(partition_no, bootstrap);


--
-- Name: public_filter_population_start public_filter_population_start_partition_no_bootstrap_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_population_start
    ADD CONSTRAINT public_filter_population_start_partition_no_bootstrap_fkey FOREIGN KEY (partition_no, bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap);


--
-- Name: public_filter_population_start public_filter_population_start_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_population_start
    ADD CONSTRAINT public_filter_population_start_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_population_start public_filter_population_start_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_population_start
    ADD CONSTRAINT public_filter_population_start_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_privacy_head public_filter_privacy_head_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_head
    ADD CONSTRAINT public_filter_privacy_head_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: public_filter_privacy_log public_filter_privacy_log_head_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_log
    ADD CONSTRAINT public_filter_privacy_log_head_fkey FOREIGN KEY (partition_no) REFERENCES semantic.public_filter_privacy_head(partition_no);


--
-- Name: public_filter_privacy_pending public_filter_privacy_pending_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_pending
    ADD CONSTRAINT public_filter_privacy_pending_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES semantic.public_filter_privacy_head(partition_no);


--
-- Name: public_filter_privacy_subject public_filter_privacy_subject_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_privacy_subject
    ADD CONSTRAINT public_filter_privacy_subject_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES semantic.public_filter_privacy_head(partition_no);


--
-- Name: public_filter_projection_build public_filter_projection_build_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_build
    ADD CONSTRAINT public_filter_projection_build_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: public_filter_projection_build public_filter_projection_build_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_build
    ADD CONSTRAINT public_filter_projection_build_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: public_filter_projection_head public_filter_projection_head_build_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_head
    ADD CONSTRAINT public_filter_projection_head_build_id_fkey FOREIGN KEY (build_id) REFERENCES semantic.public_filter_projection_build(build_id) ON DELETE CASCADE;


--
-- Name: public_filter_projection_head public_filter_projection_head_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_head
    ADD CONSTRAINT public_filter_projection_head_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: public_filter_projection_replay public_filter_projection_replay_partition_no_bootstrap_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_replay
    ADD CONSTRAINT public_filter_projection_replay_partition_no_bootstrap_fkey FOREIGN KEY (partition_no, bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap) ON DELETE CASCADE;


--
-- Name: public_filter_projection_replay public_filter_projection_replay_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_projection_replay
    ADD CONSTRAINT public_filter_projection_replay_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: public_filter_read_definition public_filter_read_definition_partition_no_source_id_confi_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_read_definition
    ADD CONSTRAINT public_filter_read_definition_partition_no_source_id_confi_fkey FOREIGN KEY (partition_no, source_id, configuration) REFERENCES semantic.public_filter_source(partition_no, source_id, configuration);


--
-- Name: public_filter_repair_advance public_filter_repair_advance_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_repair_advance
    ADD CONSTRAINT public_filter_repair_advance_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: public_filter_repair_step public_filter_repair_predecessor; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_repair_step
    ADD CONSTRAINT public_filter_repair_predecessor FOREIGN KEY (partition_no, bootstrap, execution, predecessor) REFERENCES semantic.public_filter_repair_step(partition_no, bootstrap, execution, step);


--
-- Name: public_filter_repair_step public_filter_repair_step_partition_no_bootstrap_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_repair_step
    ADD CONSTRAINT public_filter_repair_step_partition_no_bootstrap_fkey FOREIGN KEY (partition_no, bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap);


--
-- Name: public_filter_repair_step public_filter_repair_verified_successor; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_repair_step
    ADD CONSTRAINT public_filter_repair_verified_successor FOREIGN KEY (partition_no, bootstrap, execution, verified_next) REFERENCES semantic.public_filter_repair_step(partition_no, bootstrap, execution, step);


--
-- Name: public_filter_source public_filter_source_partition_no_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.public_filter_source
    ADD CONSTRAINT public_filter_source_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: record_lifecycle record_lifecycle_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_lifecycle
    ADD CONSTRAINT record_lifecycle_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: record_purge_command record_purge_command_partition_no_source_key_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_purge_command
    ADD CONSTRAINT record_purge_command_partition_no_source_key_fkey FOREIGN KEY (partition_no, source_key) REFERENCES semantic.record_purge_writer(partition_no, source_key);


--
-- Name: record_retention_document record_retention_document_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_retention_document
    ADD CONSTRAINT record_retention_document_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.record_lifecycle(route, subject_id, candidate_id);


--
-- Name: record_source_set_member record_source_set_member_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.record_source_set_member
    ADD CONSTRAINT record_source_set_member_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.record_source_set(partition_no, transaction_id);


--
-- Name: redirect redirect_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.redirect
    ADD CONSTRAINT redirect_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: release_composite release_composite_extension_route_extension_context_id_ext_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.release_composite
    ADD CONSTRAINT release_composite_extension_route_extension_context_id_ext_fkey FOREIGN KEY (extension_route, extension_context_id, extension_digest) REFERENCES semantic.context_extension(route, context_id, digest);


--
-- Name: retraction retraction_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.retraction
    ADD CONSTRAINT retraction_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: retraction retraction_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.retraction
    ADD CONSTRAINT retraction_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: revision revision_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.revision
    ADD CONSTRAINT revision_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: search_relation_probe search_relation_probe_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_relation_probe
    ADD CONSTRAINT search_relation_probe_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: search_selected search_selected_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selected
    ADD CONSTRAINT search_selected_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: search_selected search_selected_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selected
    ADD CONSTRAINT search_selected_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: search_selection_retraction search_selection_retraction_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selection_retraction
    ADD CONSTRAINT search_selection_retraction_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: search_selection_slot search_selection_slot_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selection_slot
    ADD CONSTRAINT search_selection_slot_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: search_selection_state search_selection_state_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.search_selection_state
    ADD CONSTRAINT search_selection_state_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: source_candidate source_candidate_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.source_candidate
    ADD CONSTRAINT source_candidate_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: statement_disclosure statement_disclosure_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.statement_disclosure
    ADD CONSTRAINT statement_disclosure_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: term_head term_head_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.term_head
    ADD CONSTRAINT term_head_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- PostgreSQL database dump complete
--


