-- migrate:up
-- Bind complete ordered role identities to the original prepaid capture event.
ALTER TABLE semantic.identity_receiving_capture_pending
 ADD COLUMN copy_identity text,
 ADD COLUMN source_identity text,
 ADD CONSTRAINT identity_receiving_capture_original_identity CHECK (NOT armed OR (
   copy_identity IS NOT NULL AND copy_identity ~ '^[0-9a-f]{64}$'
   AND source_identity IS NOT NULL AND source_identity ~ '^[0-9a-f]{64}$'));

CREATE OR REPLACE FUNCTION semantic.capture_erasure_roles(p_home integer,p_store text,p_key bigint,p_tx uuid)
RETURNS void LANGUAGE plpgsql AS $$
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
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.capture_erasure_roles(p_home integer,p_store text,p_key bigint,p_tx uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
 b record; provenance_key bigint; r record; native_position bigint; acting_human uuid;
 native_tx uuid:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;
 source_tx uuid; previous_account uuid; previous_role text;
 copies bigint:=0; sources bigint:=0; basis_count integer; requested_bytes integer;
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
    SELECT account_id,role INTO r FROM semantic.erasure_copy_role
     WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=source_tx
     ORDER BY account_id,role LIMIT 1;
   ELSE
    SELECT account_id,role INTO r FROM semantic.erasure_copy_role
     WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=source_tx
      AND (account_id,role)>(previous_account,previous_role) ORDER BY account_id,role LIMIT 1;
   END IF;
   EXIT WHEN NOT FOUND;
   copies:=copies+1;
   IF funded AND copies>budget.copy_roles THEN
    RAISE EXCEPTION 'identity_receiving_capture_copy_funding_changed' USING ERRCODE='23514';
   END IF;
   PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,source_tx,native_position);
   previous_account:=r.account_id; previous_role:=r.role;
  END LOOP;
 END LOOP;
 FOREACH source_tx IN ARRAY ARRAY[p_tx,CASE WHEN native_tx IS DISTINCT FROM p_tx THEN native_tx ELSE NULL END] LOOP
  CONTINUE WHEN source_tx IS NULL;
  previous_account:=NULL; previous_role:=NULL;
  LOOP
   IF previous_account IS NULL THEN
    SELECT account_id,role INTO r FROM semantic.erasure_source_role
     WHERE partition_no=p_home AND transaction_id=source_tx ORDER BY account_id,role LIMIT 1;
   ELSE
    SELECT account_id,role INTO r FROM semantic.erasure_source_role
     WHERE partition_no=p_home AND transaction_id=source_tx AND (account_id,role)>(previous_account,previous_role)
     ORDER BY account_id,role LIMIT 1;
   END IF;
   EXIT WHEN NOT FOUND;
   sources:=sources+1;
   IF funded AND sources>budget.source_roles THEN
    RAISE EXCEPTION 'identity_receiving_capture_source_funding_changed' USING ERRCODE='23514';
   END IF;
   PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,source_tx,native_position);
   previous_account:=r.account_id; previous_role:=r.role;
  END LOOP;
 END LOOP;
 IF funded AND (copies<>budget.copy_roles OR sources<>budget.source_roles) THEN
  RAISE EXCEPTION 'identity_receiving_capture_original_roles_changed' USING ERRCODE='23514';
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
END; $$;

ALTER TABLE semantic.identity_receiving_capture_pending
 DROP CONSTRAINT identity_receiving_capture_original_identity,
 DROP COLUMN source_identity,
 DROP COLUMN copy_identity;
