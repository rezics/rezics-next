-- migrate:up
-- The first locator write captures its immutable source record in the same transaction.
CREATE OR REPLACE FUNCTION semantic.record_erasure_locator(p_home integer, p_account uuid, p_role text, p_store text, p_key bigint, p_tx uuid, p_position bigint) RETURNS void
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
 state=CASE WHEN semantic.erasure_locator.delivery_position IS DISTINCT FROM EXCLUDED.delivery_position THEN 'pending' ELSE semantic.erasure_locator.state END
 WHERE (erasure_locator.source_transaction_id,erasure_locator.source_position,erasure_locator.delivery_position)
    IS DISTINCT FROM (EXCLUDED.source_transaction_id,EXCLUDED.source_position,EXCLUDED.delivery_position);
 -- A new native local obligation invalidates a previously empty local page. Late resolution uses the account-home inbox.
 UPDATE semantic.erasure_home SET state='local' WHERE partition_no=p_home AND account_id=p_account AND state='complete' AND EXISTS (SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=p_account AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.state='pending');
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.record_erasure_locator(p_home integer, p_account uuid, p_role text, p_store text, p_key bigint, p_tx uuid, p_position bigint) RETURNS void
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
