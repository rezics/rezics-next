-- migrate:up
CREATE OR REPLACE FUNCTION search.prepare_subject_ack_prefix_v1(job_id uuid, key_limit integer, byte_limit integer) RETURNS TABLE(points integer, proof_bytes integer, range_writes integer, result_writes integer)
    LANGUAGE plpgsql
    AS $$
DECLARE a search.public_filter_ack_authority; chain text; available integer; foreign_cut search.public_filter_ack_basis_v1; local_cut bytea;
  first_no integer; span integer; half integer; left_id uuid; right_id uuid; changed integer;
  member bigint; compact_stop integer; direct boolean; stamps boolean; pages integer;
  leaf_limit integer; comparison_points integer; comparison_bytes integer;
BEGIN
  IF key_limit IS NULL OR key_limit NOT BETWEEN 180 AND 1000 OR byte_limit IS NULL OR
    byte_limit NOT BETWEEN 90112 AND 4194304 THEN RAISE EXCEPTION 'Invalid Subject ACK allowance'; END IF;
  points:=24; proof_bytes:=16384; range_writes:=0; result_writes:=0;
  SELECT * INTO a FROM search.public_filter_ack_authority WHERE job=job_id AND phase='reconciled'
    AND pass=1 AND NOT fenced_pass AND fence IS NULL AND search.shared_subject_job_v1(job_id);
  IF FOUND AND NOT EXISTS (SELECT FROM search.public_filter_ack_manifest WHERE (partition_no,job)=(0,job_id)) THEN
    SELECT s.verified_binding,s.verified_home+coalesce(search.public_filter_ack_field(
      search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),'count')::integer,1)
      INTO chain,available FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution)=(0,a.bootstrap,a.execution) AND s.verified_home IS NOT NULL
      ORDER BY s.verified_home DESC LIMIT 1;
  END IF;
  IF chain IS NULL THEN RETURN NEXT; RETURN; END IF;
  -- Retain the ordinary smaller funded leaves when a full offer is unavailable
  -- at the end. Before then wait for at least one completely verified interval.
  leaf_limit:=CASE WHEN available=4096 THEN least(32,(key_limit-184)/20,(byte_limit-81920)/24576) ELSE 32 END;
  IF leaf_limit<1 OR available<leaf_limit THEN RETURN NEXT; RETURN; END IF;
  SELECT m.birth INTO STRICT member FROM core.subject_subscription_v1 m WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap);
  points:=points+21;
  foreign_cut:=search.public_filter_ack_basis_v1(true);
  local_cut:=search.public_filter_ack_range_witness(a.bootstrap,0,4096,foreign_cut);
  IF EXISTS (SELECT FROM search.public_filter_ack_range n WHERE
    (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=
    (0,job_id,chain,0,4096,local_cut)) THEN
    RETURN NEXT; RETURN;
  END IF;
  -- The root gate and foreign lanes stay locked until commit. Each descent
  -- checks the current clock and exact revision of both children. The insert
  -- trigger independently rereads them, locks their FKs, and binds adjacency.
  <<funded>> LOOP
    first_no:=0; span:=4096; direct:=false;
    LOOP
      IF span<=leaf_limit THEN
        -- A stale compact interval can spend part of this offer on stamp checks.
        -- Compare only a funded aligned leaf. The same descent joins its current children on replay.
        leaf_limit:=least(leaf_limit,(key_limit-points-40)/20,(byte_limit-proof_bytes-65536)/24576);
        EXIT WHEN span<=leaf_limit;
        EXIT funded WHEN range_writes>0 OR leaf_limit<1 OR first_no+span>available;
      END IF;
      IF span BETWEEN 64 AND 512 AND first_no+span<=available THEN
        EXIT funded WHEN points+1>key_limit;
        points:=points+1;
        SELECT stop INTO compact_stop FROM search.subject_compact_window_v1(a.bootstrap,a.execution,chain,member,first_no);
        IF compact_stop>=first_no+span THEN
          pages:=span/32;
          -- The planning recheck costs a page and its revision lookups. A
          -- changed stamp leaves this span to its children and detailed leaves.
          EXIT funded WHEN points+6*pages>key_limit;
          points:=points+6*pages;
          SELECT count(*)=pages INTO stamps FROM generate_series(first_no,first_no+span-1,32) i
            CROSS JOIN LATERAL (SELECT FROM semantic.subject_access_page_v1 p
              WHERE (p.birth,p.first_home,p.end_home)=(member,i,i+32)
                AND semantic.subject_repair_page_current_v1(p) LIMIT 1) current_page;
          IF stamps THEN direct:=true; EXIT; END IF;
        END IF;
      END IF;
      half:=span/2;
      EXIT funded WHEN points+3>key_limit;
      points:=points+3;
      local_cut:=search.public_filter_ack_range_witness(a.bootstrap,first_no,half,foreign_cut);
      SELECT revision INTO left_id FROM search.public_filter_ack_range n WHERE
        (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=
        (0,job_id,chain,first_no,half,local_cut);
      IF left_id IS NULL THEN span:=half; CONTINUE; END IF;
      EXIT funded WHEN first_no+half>=available OR points+3>key_limit;
      points:=points+3;
      local_cut:=search.public_filter_ack_range_witness(a.bootstrap,first_no+half,half,foreign_cut);
      SELECT revision INTO right_id FROM search.public_filter_ack_range n WHERE
        (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,job_id,chain,first_no+half,half,
          local_cut);
      IF right_id IS NOT NULL THEN EXIT; END IF;
      first_no:=first_no+half; span:=half;
    END LOOP;
    EXIT WHEN first_no+span>available;
    IF direct THEN
      left_id:=NULL; right_id:=NULL;
      -- Native binding, original closure of at most 64 keys, current foreign
      -- and local clocks; each 32-home page costs three originals and its stamp.
      -- Reopen one retained step (at most 16 KiB) and its 64 finite command ends.
      comparison_points:=201+8*pages; comparison_bytes:=90112+8192*pages;
    ELSIF span<=leaf_limit THEN
      left_id:=NULL; right_id:=NULL;
      comparison_points:=40+20*span; comparison_bytes:=65536+24576*span;
    ELSE
      comparison_points:=64; comparison_bytes:=65536;
    END IF;
    EXIT WHEN points+comparison_points>key_limit OR proof_bytes+comparison_bytes>byte_limit;
    points:=points+comparison_points; proof_bytes:=proof_bytes+comparison_bytes;
    INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
      VALUES(0,a.registration,a.bootstrap,first_no/greatest(span,16)*greatest(span,16),greatest(span,16))
      ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed=ROW_COUNT;
    result_writes:=result_writes+changed;
    INSERT INTO search.public_filter_ack_range(partition_no,job,binding,first_home,width,left_child,right_child)
      VALUES(0,job_id,chain,first_no,span,left_id,right_id) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed=ROW_COUNT;
    range_writes:=range_writes+changed; result_writes:=result_writes+changed;
    EXIT WHEN changed=0 OR span=4096;
  END LOOP;
  RETURN NEXT;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Funded Subject receiver leaves require forward migration'; END $$;
