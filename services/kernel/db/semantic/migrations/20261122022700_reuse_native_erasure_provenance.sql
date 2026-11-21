-- migrate:up
CREATE OR REPLACE FUNCTION semantic.capture_erasure_roles_unfunded(p_home integer, p_store text, p_key bigint, p_tx uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
 -- Every captured record can refer to the same immutable write basis. Its own
 -- transaction already holds the provenance row it just created or locked.
 SELECT record_key INTO provenance_key FROM semantic.erasure_provenance
 WHERE partition_no=p_home AND transaction_id=p_tx AND xmin::text=pg_current_xact_id()::text;
 IF NOT FOUND THEN
   INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,p_tx)
   ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
   RETURNING record_key INTO provenance_key;
 END IF;
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
END; $function$;

CREATE OR REPLACE FUNCTION semantic.record_erasure_locator(p_home integer, p_account uuid, p_role text, p_store text, p_key bigint, p_tx uuid, p_position bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE delivery bigint; locator_state text; is_global boolean:=false;
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
 state=CASE WHEN semantic.erasure_locator.delivery_position IS DISTINCT FROM EXCLUDED.delivery_position THEN 'pending' ELSE semantic.erasure_locator.state END
 WHERE (erasure_locator.source_transaction_id,erasure_locator.source_position,erasure_locator.delivery_position)
    IS DISTINCT FROM (EXCLUDED.source_transaction_id,EXCLUDED.source_position,EXCLUDED.delivery_position)
 RETURNING state INTO locator_state;
 -- The writer already owns the locator. A changed row reports its state directly.
 -- An unchanged survivor only needs its state checked when a completed home can reopen.
 IF locator_state='pending' THEN
  UPDATE semantic.erasure_home SET state='local'
  WHERE partition_no=p_home AND account_id=p_account AND state='complete';
 ELSIF locator_state IS NULL THEN
  UPDATE semantic.erasure_home h SET state='local'
  WHERE h.partition_no=p_home AND h.account_id=p_account AND h.state='complete'
    AND EXISTS (SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=h.partition_no
      AND l.account_id=h.account_id AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.state='pending');
 END IF;
END; $function$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.record_erasure_locator(p_home integer, p_account uuid, p_role text, p_store text, p_key bigint, p_tx uuid, p_position bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
 state=CASE WHEN semantic.erasure_locator.delivery_position IS DISTINCT FROM EXCLUDED.delivery_position THEN 'pending' ELSE semantic.erasure_locator.state END
 WHERE (erasure_locator.source_transaction_id,erasure_locator.source_position,erasure_locator.delivery_position)
    IS DISTINCT FROM (EXCLUDED.source_transaction_id,EXCLUDED.source_position,EXCLUDED.delivery_position);
 -- A new native local obligation invalidates a previously empty local page. Late resolution uses the account-home inbox.
 UPDATE semantic.erasure_home SET state='local' WHERE partition_no=p_home AND account_id=p_account AND state='complete' AND EXISTS (SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=p_account AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.state='pending');
END; $function$;

CREATE OR REPLACE FUNCTION semantic.capture_erasure_roles_unfunded(p_home integer, p_store text, p_key bigint, p_tx uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
END; $function$;
