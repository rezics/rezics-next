-- migrate:up
-- Empty initial homes use the same three committed native stages and retained records as
-- populated pages. Fuse only statements within each local command, never the commit boundaries.
CREATE FUNCTION semantic.export_identity_epoch_empty_bootstrap(p_home integer,p_tx uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
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

CREATE FUNCTION semantic.receive_identity_epoch_empty_bootstrap(
  p_home integer,p_export uuid,p_epoch integer,p_position bigint,p_tx uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
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

CREATE FUNCTION semantic.ack_identity_epoch_empty_bootstrap(
  p_home integer,p_export uuid,p_received uuid,p_epoch integer,p_position bigint,p_tx uuid)
RETURNS TABLE(applied boolean,sealed boolean) LANGUAGE plpgsql AS $$
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

-- migrate:down
DROP FUNCTION semantic.ack_identity_epoch_empty_bootstrap(integer,uuid,uuid,integer,bigint,uuid);
DROP FUNCTION semantic.receive_identity_epoch_empty_bootstrap(integer,uuid,integer,bigint,uuid);
DROP FUNCTION semantic.export_identity_epoch_empty_bootstrap(integer,uuid);
