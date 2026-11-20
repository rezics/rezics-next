-- migrate:up
-- Wider direct leaves use the existing per-subtree clock. Every classified
-- home mutation already advances both the 16- and 32-home ancestors.
ALTER TABLE search.public_filter_ack_range DROP CONSTRAINT public_filter_ack_range_check1,
  ADD CONSTRAINT public_filter_ack_range_children CHECK (
    (left_child IS NULL)=(right_child IS NULL) AND (width<=32 OR left_child IS NOT NULL));

CREATE OR REPLACE FUNCTION search.compare_public_filter_ack_range() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  l search.public_filter_ack_range%ROWTYPE;
  r search.public_filter_ack_range%ROWTYPE;
  homes integer;
  chain_ok boolean;
  foreign_cut bytea;
  child_cut bytea;
  previous_node search.public_filter_ack_range%ROWTYPE;
BEGIN
  IF NEW.partition_no<>0 OR NEW.first_home NOT BETWEEN 0 AND 4095 OR NEW.width NOT IN
    (1,2,4,8,16,32,64,128,256,512,1024,2048,4096) OR NEW.first_home%NEW.width<>0 THEN
    RAISE EXCEPTION 'Invalid receiver interval' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority
    WHERE job=NEW.job AND phase='reconciled' AND pass=1 AND NOT fenced_pass AND fence IS NULL;
  NEW.registration := a.registration;
  NEW.bootstrap := a.bootstrap;
  NEW.revision := gen_random_uuid();
  NEW.identity_digest := a.identity_digest;
  IF NEW.width<=32 AND NEW.left_child IS NULL AND NEW.right_child IS NULL THEN
    UPDATE search.public_filter_coverage_home h SET baseline_delta=true
    WHERE (h.partition_no,h.registration,h.baseline_bootstrap)=(0,a.registration,a.bootstrap)
      AND h.source_home>=NEW.first_home AND h.source_home<NEW.first_home+NEW.width AND h.baseline_delta IS NULL;
  END IF;
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(0,a.registration,a.bootstrap,NEW.first_home/greatest(NEW.width,16)*greatest(NEW.width,16),greatest(NEW.width,16))
    ON CONFLICT DO NOTHING;
  foreign_cut := search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']);
  NEW.witness := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width,foreign_cut);
  IF NEW.width<=32 AND NEW.left_child IS NULL AND NEW.right_child IS NULL THEN
    WITH steps AS MATERIALIZED (
      (SELECT s.step,s.state,s.verified_root,s.verified_ordinal,s.verified_home
       FROM semantic.public_filter_repair_step s
       WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_binding=NEW.binding
         AND s.verified_home<=NEW.first_home AND s.verified_root IS NOT NULL AND NOT s.complete
       ORDER BY s.verified_home DESC LIMIT 1)
      UNION ALL
      SELECT s.step,s.state,s.verified_root,s.verified_ordinal,s.verified_home FROM semantic.public_filter_repair_step s
       WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_binding=NEW.binding
         AND s.verified_home>NEW.first_home AND s.verified_home<NEW.first_home+NEW.width
         AND s.verified_root IS NOT NULL AND NOT s.complete
    ), windows AS (
      SELECT steps.*,lead(verified_home,1,NEW.first_home+NEW.width) OVER (ORDER BY verified_home) AS end_home FROM steps
    ), members AS MATERIALIZED (
      SELECT i.home,w.step,w.verified_root,w.verified_ordinal,win.through_pos,b.predecessor,b.root,
        b.receipt,b.creation_position,b.source_epoch,b.source_position,b.native_enqueue_revision,
        b.native_revision,b.native_claim_revision,h.acknowledged_position,h.acknowledged_native_enqueue,
        h.relevant_position,h.native_enqueue_revision AS current_enqueue,h.native_revision AS current_revision,
        h.native_claim_revision AS current_claim,h.last_change_generation,h.baseline_delta,
        ph.position AS privacy_position,ac.revision AS account_revision,ac.claim_revision AS account_claim
      FROM windows w
      CROSS JOIN LATERAL generate_series(greatest(w.verified_home,NEW.first_home),w.end_home-1) i(home)
      CROSS JOIN LATERAL search.public_filter_ack_window(w.state,i.home) win
      JOIN semantic.public_filter_home_enrollment e ON (e.partition_no,e.bootstrap)=(i.home,a.bootstrap)
        AND e.complete AND e.registration_partition=0 AND e.registration=a.registration AND e.read_definition=a.read_definition
        AND (e.owner_epoch,e.receipt,e.creation_position)=(win.epoch,win.receipt,win.base)
        AND e.creation_consumer='public_filter_'||replace(a.bootstrap::text,'-','')
      JOIN core.partition p ON p.partition_no=i.home AND p.epoch=e.owner_epoch AND p.write_state='active' AND p.position>=win.through_pos
      JOIN core.consumer_checkpoint ck ON (ck.partition_no,ck.consumer)=(i.home,e.creation_consumer)
        AND ck.position<=win.base AND (ck.epoch IS NULL OR ck.epoch=p.epoch)
      JOIN semantic.public_filter_privacy_head ph ON ph.partition_no=i.home AND ph.owner_epoch=p.epoch AND ph.position>=e.source_position
      JOIN access.account_discovery_population ac ON ac.partition_no=i.home
      JOIN search.public_filter_coverage_baseline b ON (b.partition_no,b.registration,b.bootstrap,b.source_home)=(0,a.registration,a.bootstrap,i.home)
        AND (b.source_epoch,b.receipt,b.creation_position,b.source_position,b.native_enqueue_revision)=
            (e.owner_epoch,e.receipt,e.creation_position,e.source_position,e.native_enqueue_revision)
        AND b.native_revision IS NOT DISTINCT FROM e.native_revision AND b.native_claim_revision IS NOT DISTINCT FROM e.native_claim_revision
      JOIN search.public_filter_coverage_home h ON (h.partition_no,h.registration,h.source_home)=(0,a.registration,i.home)
        AND h.source_epoch=e.owner_epoch AND h.baseline_bootstrap=e.bootstrap
        AND h.acknowledged_position<=b.source_position AND h.acknowledged_native_enqueue<=b.native_enqueue_revision
      WHERE e.partition_no>=NEW.first_home AND e.partition_no<NEW.first_home+NEW.width
        AND b.source_home>=NEW.first_home AND b.source_home<NEW.first_home+NEW.width
        AND h.source_home>=NEW.first_home AND h.source_home<NEW.first_home+NEW.width
        AND h.baseline_delta=(h.relevant_position>b.source_position OR h.native_enqueue_revision>b.native_enqueue_revision
        OR h.native_revision IS DISTINCT FROM b.native_revision OR h.native_claim_revision IS DISTINCT FROM b.native_claim_revision)
    ), ordered AS (
      SELECT m.*,lag(root) OVER (ORDER BY home) AS prior FROM members m
    )
    SELECT count(*),bool_and(prior IS NULL OR prior=predecessor),
      max(predecessor) FILTER (WHERE home=NEW.first_home),max(root) FILTER (WHERE home=NEW.first_home+NEW.width-1),
      sha256(convert_to(jsonb_agg(to_jsonb(ordered) ORDER BY home)::text,'UTF8'))
    INTO homes,chain_ok,NEW.predecessor,NEW.enrollment_root,NEW.digest FROM ordered;
    IF homes<>NEW.width OR chain_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'Original receiver home evidence unavailable' USING ERRCODE='40001';
    END IF;
  ELSE
    child_cut := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width/2,foreign_cut);
    SELECT * INTO STRICT l FROM search.public_filter_ack_range
      WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home,NEW.width/2,child_cut);
    child_cut := search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home+NEW.width/2,NEW.width/2,foreign_cut);
    SELECT * INTO STRICT r FROM search.public_filter_ack_range
      WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home+NEW.width/2,NEW.width/2,child_cut);
    IF (l.registration,l.bootstrap,l.enrollment_root) IS DISTINCT FROM (a.registration,a.bootstrap,r.predecessor)
      OR (r.registration,r.bootstrap) IS DISTINCT FROM (a.registration,a.bootstrap)
      OR l.identity_digest<>a.identity_digest OR r.identity_digest<>a.identity_digest THEN
      RAISE EXCEPTION 'Discontinuous receiver range' USING ERRCODE='40001';
    END IF;
    NEW.left_child := l.revision;
    NEW.right_child := r.revision;
    NEW.predecessor := l.predecessor;
    NEW.enrollment_root := r.enrollment_root;
    NEW.digest := sha256(uuid_send(l.revision)||l.digest||uuid_send(r.revision)||r.digest);
  END IF;
  NEW.digest := sha256(convert_to(jsonb_build_array('subject-receiver-baseline/v1',a.job,a.registration,a.bootstrap,
    a.read_definition,a.release_digest,a.owner_epoch,a.physical_target,a.incarnation,a.observation,a.execution,
    a.identity_digest,a.generation,a.enrollment_root,NEW.binding,NEW.first_home,NEW.width,NEW.witness,NEW.digest)::text,'UTF8'));
  SELECT * INTO previous_node FROM search.public_filter_ack_range
    WHERE (partition_no,job,binding,first_home,width,witness)=(0,NEW.job,NEW.binding,NEW.first_home,NEW.width,NEW.witness);
  IF FOUND AND (previous_node.digest,previous_node.bootstrap,previous_node.registration,previous_node.left_child,previous_node.right_child) IS DISTINCT FROM
    (NEW.digest,NEW.bootstrap,NEW.registration,NEW.left_child,NEW.right_child) THEN
    RAISE EXCEPTION 'Conflicting receiver range replay' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
-- Prepare at most one retained frontier with the remaining Source allowance.
CREATE FUNCTION search.prepare_public_filter_ack_batch(job_id uuid, key_limit integer, byte_limit integer)
RETURNS TABLE(points integer, proof_bytes integer, range_writes integer, result_writes integer)
LANGUAGE plpgsql AS $$
DECLARE
  a search.public_filter_ack_authority%ROWTYPE;
  chain text;
  available integer;
  foreign_cut bytea;
  local_cut bytea;
  span integer := 4096;
  first_no integer := 0;
  leaf_limit integer;
  members integer;
  left_id uuid;
  right_id uuid;
  changed integer;
  comparison_points integer;
BEGIN
  IF key_limit IS NULL OR key_limit NOT BETWEEN 180 AND 1000 OR
     byte_limit IS NULL OR byte_limit NOT BETWEEN 90112 AND 4194304 THEN
    RAISE EXCEPTION 'Invalid receiver range allowance' USING ERRCODE='22023';
  END IF;
  points := 20; proof_bytes := 65536; range_writes := 0; result_writes := 0;
  leaf_limit := least(32,(key_limit-160)/20,(byte_limit-65536)/24576);
  SELECT * INTO a FROM search.public_filter_ack_authority WHERE job=job_id AND phase='reconciled' AND pass=1
    AND fence IS NULL AND NOT fenced_pass;
  IF FOUND AND NOT EXISTS (SELECT FROM search.public_filter_ack_manifest WHERE (partition_no,job)=(0,job_id)) THEN
    SELECT s.verified_binding,s.verified_home+coalesce(search.public_filter_ack_field(
      search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),'count')::integer,1)
      INTO chain,available FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_home IS NOT NULL
      ORDER BY s.verified_home DESC LIMIT 1;
  END IF;
  IF chain IS NOT NULL THEN
    points := points+28;
    foreign_cut := search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']);
    local_cut := search.public_filter_ack_range_witness(a.bootstrap,0,4096,foreign_cut);
    IF local_cut IS NOT NULL AND NOT EXISTS (SELECT FROM search.public_filter_ack_range n WHERE
      (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,0,4096,local_cut)) THEN
      LOOP
        EXIT WHEN first_no>=available;
        members := 0;
        left_id := NULL;
        right_id := NULL;
        IF span<=leaf_limit THEN
          -- The next verified window completes this same leaf. Smaller
          -- fragments here would be compared again by its eventual direct leaf.
          EXIT WHEN first_no+span>available;
          members := span;
        ELSE
          -- Two indexed child lookups, each with its gate and local clock.
          EXIT WHEN points+3>key_limit;
          points := points+3;
          local_cut := search.public_filter_ack_range_witness(a.bootstrap,first_no,span/2,foreign_cut);
          SELECT revision INTO left_id FROM search.public_filter_ack_range n WHERE
            (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first_no,span/2,local_cut);
          IF left_id IS NULL THEN span := span/2; CONTINUE; END IF;
          EXIT WHEN points+3>key_limit;
          points := points+3;
          local_cut := search.public_filter_ack_range_witness(a.bootstrap,first_no+span/2,span/2,foreign_cut);
          SELECT revision INTO right_id FROM search.public_filter_ack_range n WHERE
            (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first_no+span/2,span/2,local_cut);
          IF right_id IS NULL THEN first_no := first_no+span/2; span := span/2; CONTINUE; END IF;
        END IF;

        -- Reserve the comparison's native authority, witness, replay and FK
        -- reads. A direct leaf also consumes the original step for every home.
        comparison_points := CASE WHEN members>0 THEN 40+20*members ELSE 64 END;
        EXIT WHEN points+comparison_points>key_limit;
        points := points+comparison_points;
        proof_bytes := proof_bytes+24576*members;
        -- Stage the same inputs the before-insert verifier requires. Count only
        -- actual writes, including first use of a clock or a home marker.
        IF members>0 THEN
          UPDATE search.public_filter_coverage_home h SET baseline_delta=true
            WHERE (h.partition_no,h.registration,h.baseline_bootstrap)=(0,a.registration,a.bootstrap)
              AND h.source_home>=first_no AND h.source_home<first_no+span AND h.baseline_delta IS NULL;
          GET DIAGNOSTICS changed = ROW_COUNT;
          result_writes := result_writes+changed;
        END IF;
        INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
          VALUES(0,a.registration,a.bootstrap,first_no/greatest(span,16)*greatest(span,16),greatest(span,16))
          ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS changed = ROW_COUNT;
        result_writes := result_writes+changed;
        INSERT INTO search.public_filter_ack_range(partition_no,job,binding,first_home,width,left_child,right_child)
          VALUES(0,job_id,chain,first_no,span,left_id,right_id) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS changed = ROW_COUNT;
        range_writes := range_writes+changed;
        result_writes := result_writes+changed;
        EXIT;
      END LOOP;
    END IF;
  END IF;
  RETURN NEXT;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original wide receiver ranges require forward migration'; END $$;
