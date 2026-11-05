-- migrate:up
-- The physical minimization queue is keyed by physical role. The immutable native
-- directory owns provenance: equal delivery positions do not identify an origin.
-- The slash encodes the nullable transaction/position pair; it is not a synthetic
-- transaction or a fabricated delivery position. UUID and bigint encodings cannot
-- contain a slash, so even unattributed historical roles have an unambiguous key.
ALTER TABLE semantic.erasure_source_record ADD COLUMN origin_key text
 GENERATED ALWAYS AS ((coalesce(source_transaction_id::text, '') || '/') || coalesce(source_position::text, '')) STORED NOT NULL;
ALTER TABLE semantic.erasure_source_record DROP CONSTRAINT erasure_source_record_pkey;
ALTER TABLE semantic.erasure_source_record ADD CONSTRAINT erasure_source_record_pkey
 PRIMARY KEY(partition_no,account_id,role,store,record_key,delivery_position,origin_key);
DROP INDEX semantic.erasure_source_record_key;
CREATE INDEX erasure_source_record_key ON semantic.erasure_source_record
 (partition_no,account_id,store,record_key,role,delivery_position,origin_key);
-- A sealed replay must seek its authentic origin without scanning other deliveries.
CREATE INDEX erasure_source_record_origin ON semantic.erasure_source_record
 (partition_no,account_id,role,store,record_key,(coalesce(source_transaction_id::text,'')),source_position);

-- Null means an older transfer did not bind an origin. It must not be upgraded
-- using today's physical locator. The reader refuses that unproven transfer.
ALTER TABLE semantic.erasure_source_hold ADD COLUMN origin_key text;
ALTER TABLE semantic.erasure_source_page ADD COLUMN origin_key text;
ALTER TABLE semantic.erasure_source_terminal ADD COLUMN origin_key text;

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

-- migrate:down
-- A rollback may not discard a second authentic origin. Leave the migration
-- installed when its old unique key cannot represent the committed population.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM semantic.erasure_source_record
  GROUP BY partition_no,account_id,role,store,record_key,delivery_position HAVING count(*)>1)
 THEN RAISE EXCEPTION 'distinct_erasure_origins_cannot_be_collapsed' USING ERRCODE='23514'; END IF;
END; $$;
CREATE OR REPLACE FUNCTION semantic.record_erasure_locator(p_home integer, p_account uuid, p_role text, p_store text, p_key bigint, p_tx uuid, p_position bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE delivery bigint; is_global boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM semantic.erasure_source_seal s WHERE s.partition_no=p_home AND s.account_id=p_account) THEN
  -- Re-reporting unchanged provenance of a survivor's existing row creates no new role.
  IF EXISTS(SELECT 1 FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=p_account
    AND l.role=p_role AND l.store=p_store AND l.record_key=p_key AND l.source_transaction_id IS NOT DISTINCT FROM p_tx) THEN RETURN; END IF;
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
DROP INDEX semantic.erasure_source_record_origin;
ALTER TABLE semantic.erasure_source_hold DROP COLUMN origin_key;
ALTER TABLE semantic.erasure_source_page DROP COLUMN origin_key;
ALTER TABLE semantic.erasure_source_terminal DROP COLUMN origin_key;
DROP INDEX semantic.erasure_source_record_key;
ALTER TABLE semantic.erasure_source_record DROP CONSTRAINT erasure_source_record_pkey;
ALTER TABLE semantic.erasure_source_record DROP COLUMN origin_key;
ALTER TABLE semantic.erasure_source_record ADD CONSTRAINT erasure_source_record_pkey
 PRIMARY KEY(partition_no,account_id,role,store,record_key,delivery_position);
CREATE INDEX erasure_source_record_key ON semantic.erasure_source_record
 (partition_no,account_id,store,record_key,role,delivery_position);
