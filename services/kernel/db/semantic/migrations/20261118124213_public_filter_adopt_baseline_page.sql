-- migrate:up
-- Source passes only the contiguous prefix of independently verified owner
-- receipts. Advance Search then Source for each home so the existing triggers
-- check every original predecessor and the whole page commits atomically.
CREATE FUNCTION semantic.adopt_public_filter_baseline_page(
  registration_id text, bootstrap_id uuid, definition_id uuid, encoded_consumer text,
  include_accounts boolean, receipts jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  preparation search.public_filter_coverage_preparation%ROWTYPE;
  home record;
  current_epoch integer;
  change_generation bigint;
  next_root text;
BEGIN
  IF receipts IS NULL OR jsonb_array_length(receipts) NOT BETWEEN 1 AND 29 THEN
    RAISE EXCEPTION 'Coverage adoption requires a bounded receipt page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO preparation FROM search.public_filter_coverage_preparation c
  WHERE (c.partition_no,c.registration,c.bootstrap)=(0,registration_id,bootstrap_id)
    AND c.definition=definition_id AND c.consumer=encoded_consumer
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Coverage adoption lost its original preparation' USING ERRCODE='40001';
  END IF;

  FOR home IN
    SELECT * FROM jsonb_to_recordset(receipts) AS r(partition integer, epoch integer,
      source_position bigint, creation_position bigint, enqueue_revision bigint,
      revision bigint, claim_revision bigint, receipt text)
    ORDER BY r.partition
  LOOP
    IF preparation.after_home IS DISTINCT FROM home.partition THEN
      RAISE EXCEPTION 'Coverage adoption lost its contiguous frontier' USING ERRCODE='40001';
    END IF;
    -- Reproduce the retained SHA-256 of the compact JSON tuple. The previous
    -- root and the receipt consist only of hexadecimal characters.
    next_root := encode(sha256(convert_to(format('["%s",%s,"%s"]',
      preparation.root,home.partition,home.receipt),'UTF8')),'hex');
    INSERT INTO search.public_filter_coverage_baseline
      (partition_no,registration,bootstrap,source_home,source_epoch,source_position,creation_position,
       native_enqueue_revision,native_revision,native_claim_revision,receipt,predecessor,root)
    VALUES (0,registration_id,bootstrap_id,home.partition,home.epoch,home.source_position,home.creation_position,
      home.enqueue_revision,CASE WHEN include_accounts THEN home.revision END,
      CASE WHEN include_accounts THEN home.claim_revision END,home.receipt,preparation.root,next_root);

    SELECT h.source_epoch INTO current_epoch FROM search.public_filter_coverage_home h
    WHERE (h.partition_no,h.registration,h.source_home)=(0,registration_id,home.partition) FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO search.public_filter_coverage_home
        (partition_no,registration,source_home,source_epoch,relevant_position,native_enqueue_revision,
         native_revision,native_claim_revision,last_change_generation,behind,baseline_bootstrap)
      VALUES (0,registration_id,home.partition,home.epoch,home.source_position,home.enqueue_revision,
        CASE WHEN include_accounts THEN home.revision END,CASE WHEN include_accounts THEN home.claim_revision END,
        0,true,bootstrap_id);
    ELSIF current_epoch <> home.epoch THEN
      UPDATE search.public_filter_registration SET coverage_generation=coverage_generation+1
      WHERE (partition_no,id)=(0,registration_id) RETURNING coverage_generation INTO change_generation;
      UPDATE search.public_filter_coverage_home SET source_epoch=home.epoch,relevant_position=home.source_position,
        native_enqueue_revision=home.enqueue_revision,native_revision=CASE WHEN include_accounts THEN home.revision END,
        native_claim_revision=CASE WHEN include_accounts THEN home.claim_revision END,
        acknowledged_position=0,acknowledged_native_enqueue=0,acknowledged_native_revision=NULL,
        acknowledged_native_claim_revision=NULL,baseline_bootstrap=bootstrap_id,acknowledged_baseline=NULL,
        last_change_generation=change_generation,behind=true
      WHERE (partition_no,registration,source_home)=(0,registration_id,home.partition);
    ELSE
      -- Each original enrollment still owes repair. Preserve real changes to
      -- the same native epoch, including its current counters and generation.
      UPDATE search.public_filter_coverage_home SET baseline_bootstrap=bootstrap_id,behind=true
      WHERE (partition_no,registration,source_home)=(0,registration_id,home.partition);
    END IF;

    UPDATE search.public_filter_coverage_preparation SET after_home=home.partition+1,root=next_root
    WHERE (partition_no,registration,bootstrap)=(0,registration_id,bootstrap_id);
    -- The registration transaction already holds a share lock on Core home 0.
    PERFORM 1 FROM semantic.public_filter_bootstrap b JOIN core.partition p USING (partition_no)
    WHERE (b.partition_no,b.bootstrap)=(0,bootstrap_id) AND b.state='capturing'
      AND b.account_after=home.partition AND b.coverage_after=b.account_after
      AND b.coverage_generation=preparation.generation AND b.read_definition=definition_id
      AND p.epoch=b.owner_epoch AND p.write_state='active'
    FOR UPDATE OF b;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Coverage adoption lost its Source frontier' USING ERRCODE='40001';
    END IF;
    INSERT INTO semantic.public_filter_bootstrap_account
      (partition_no,bootstrap,account_partition,owner_epoch,revision,claim_revision)
    VALUES (0,bootstrap_id,home.partition,home.epoch,home.revision,home.claim_revision);
    UPDATE semantic.public_filter_bootstrap SET account_after=home.partition+1,coverage_after=home.partition+1,
      coverage_root=next_root,coverage_sealed=home.partition=4095,
      state=CASE WHEN home.partition=4095 THEN 'begun' ELSE 'capturing' END
    WHERE (partition_no,bootstrap)=(0,bootstrap_id);
    preparation.after_home := home.partition+1;
    preparation.root := next_root;
  END LOOP;
END $$;

-- migrate:down
DROP FUNCTION semantic.adopt_public_filter_baseline_page(text,uuid,uuid,text,boolean,jsonb);
