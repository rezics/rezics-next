-- migrate:up
-- Keep the original one-home cursor transitions valid for workers deployed
-- before this migration. The same registration lock protects page adoption.
CREATE FUNCTION search.public_filter_baseline_interval(
  owner_partition integer, registration_id text, bootstrap_id uuid,
  first_home integer, after_home integer, first_root text, final_root text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  -- The original PK admits one row per home. Cardinality proves that the
  -- bounded interval has no holes, including at either endpoint.
  SELECT CASE WHEN first_home BETWEEN 0 AND 4095 AND after_home BETWEEN 1 AND 4096
    AND after_home::bigint-first_home BETWEEN 1 AND 29 THEN (
    SELECT (count(*)=after_home-first_home
      AND bool_and(b.predecessor IS NOT DISTINCT FROM b.expected_predecessor)
      AND max(b.root) FILTER (WHERE b.source_home=after_home-1)=final_root) IS TRUE
    FROM (
      SELECT b.source_home,b.predecessor,b.root,
        lag(b.root,1,first_root) OVER (ORDER BY b.source_home) AS expected_predecessor
      FROM search.public_filter_coverage_baseline b
      WHERE (b.partition_no,b.registration,b.bootstrap)=(owner_partition,registration_id,bootstrap_id)
        AND b.source_home>=first_home AND b.source_home<after_home
    ) b
  ) ELSE false END
$$;

CREATE OR REPLACE FUNCTION search.advance_public_filter_coverage_preparation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.partition_no,NEW.registration,NEW.bootstrap,NEW.definition,NEW.consumer,NEW.generation)
     IS DISTINCT FROM
     (OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.definition,OLD.consumer,OLD.generation)
  THEN
    RAISE EXCEPTION 'Original coverage preparation binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD AND NOT search.public_filter_baseline_interval(
    OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.after_home,NEW.after_home,OLD.root,NEW.root)
  THEN
    RAISE EXCEPTION 'Coverage preparation requires its original contiguous receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION semantic.retain_public_filter_baseline_seal() RETURNS trigger
LANGUAGE plpgsql AS $$
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
    AND (NEW.coverage_after-OLD.coverage_after NOT BETWEEN 1 AND 29 OR NEW.account_after<>NEW.coverage_after OR NOT EXISTS (
      SELECT 1 FROM search.public_filter_coverage_preparation c
      WHERE c.partition_no=NEW.partition_no AND c.bootstrap=NEW.bootstrap
        AND c.definition=NEW.read_definition AND c.generation=NEW.coverage_generation
        AND c.after_home=NEW.coverage_after AND c.root=NEW.coverage_root
        AND (NEW.coverage_after=OLD.coverage_after+1 OR (
          -- Start at Source's own predecessor and require every corresponding
          -- bootstrap account, even if the Search frontier is already present.
          OLD.account_after=OLD.coverage_after AND search.public_filter_baseline_interval(
            c.partition_no,c.registration,c.bootstrap,OLD.coverage_after,NEW.coverage_after,
            OLD.coverage_root,NEW.coverage_root)
          AND (SELECT count(*) FROM semantic.public_filter_bootstrap_account a
            WHERE (a.partition_no,a.bootstrap)=(OLD.partition_no,OLD.bootstrap)
              AND a.account_partition>=OLD.coverage_after AND a.account_partition<NEW.coverage_after
          )=NEW.coverage_after-OLD.coverage_after))))
  THEN
    RAISE EXCEPTION 'Source seal requires its native contiguous coverage preparation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION semantic.adopt_public_filter_baseline_page(
  registration_id text, bootstrap_id uuid, definition_id uuid, encoded_consumer text,
  include_accounts boolean, receipts jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  preparation search.public_filter_coverage_preparation%ROWTYPE;
  home record;
  current_epoch integer;
  change_generation bigint;
  next_root text;
  frontier integer;
  page_root text;
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

  frontier := preparation.after_home;
  page_root := preparation.root;
  FOR home IN
    SELECT * FROM jsonb_to_recordset(receipts) AS r(partition integer, epoch integer,
      source_position bigint, creation_position bigint, enqueue_revision bigint,
      revision bigint, claim_revision bigint, receipt text)
    ORDER BY r.partition
  LOOP
    IF frontier IS DISTINCT FROM home.partition OR frontier >= 4096 THEN
      RAISE EXCEPTION 'Coverage adoption lost its contiguous frontier' USING ERRCODE='40001';
    END IF;
    -- Reproduce the retained SHA-256 of the compact JSON tuple. The previous
    -- root and the receipt consist only of hexadecimal characters.
    next_root := encode(sha256(convert_to(format('["%s",%s,"%s"]',
      page_root,home.partition,home.receipt),'UTF8')),'hex');
    INSERT INTO search.public_filter_coverage_baseline
      (partition_no,registration,bootstrap,source_home,source_epoch,source_position,creation_position,
       native_enqueue_revision,native_revision,native_claim_revision,receipt,predecessor,root)
    VALUES (0,registration_id,bootstrap_id,home.partition,home.epoch,home.source_position,home.creation_position,
      home.enqueue_revision,CASE WHEN include_accounts THEN home.revision END,
      CASE WHEN include_accounts THEN home.claim_revision END,home.receipt,page_root,next_root);

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

    -- Preserve the registration -> preparation -> first receiver home ->
    -- Source bootstrap lock order. Core home 0 is already share locked.
    IF frontier=preparation.after_home THEN
      PERFORM 1 FROM semantic.public_filter_bootstrap b JOIN core.partition p USING (partition_no)
      WHERE (b.partition_no,b.bootstrap)=(0,bootstrap_id) AND b.state='capturing'
        AND b.account_after=frontier AND b.coverage_after=frontier AND b.coverage_root=page_root
        AND b.coverage_generation=preparation.generation AND b.read_definition=definition_id
        AND p.epoch=b.owner_epoch AND p.write_state='active'
      FOR UPDATE OF b;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Coverage adoption lost its Source frontier' USING ERRCODE='40001';
      END IF;
    END IF;
    INSERT INTO semantic.public_filter_bootstrap_account
      (partition_no,bootstrap,account_partition,owner_epoch,revision,claim_revision)
    VALUES (0,bootstrap_id,home.partition,home.epoch,home.revision,home.claim_revision);
    frontier := frontier+1;
    page_root := next_root;
  END LOOP;

  UPDATE search.public_filter_coverage_preparation SET after_home=frontier,root=page_root
  WHERE (partition_no,registration,bootstrap)=(0,registration_id,bootstrap_id)
    AND after_home=preparation.after_home AND root=preparation.root;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Coverage adoption lost its contiguous frontier' USING ERRCODE='40001';
  END IF;

  UPDATE semantic.public_filter_bootstrap SET account_after=frontier,coverage_after=frontier,
    coverage_root=page_root,coverage_sealed=frontier=4096,
    state=CASE WHEN frontier=4096 THEN 'begun' ELSE 'capturing' END
  WHERE (partition_no,bootstrap)=(0,bootstrap_id) AND state='capturing'
    AND account_after=preparation.after_home AND coverage_after=preparation.after_home
    AND coverage_root=preparation.root AND coverage_generation=preparation.generation
    AND read_definition=definition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Coverage adoption lost its Source frontier' USING ERRCODE='40001';
  END IF;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Public-filter baseline page cursors require forward migration'; END $$;
