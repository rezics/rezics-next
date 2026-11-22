-- migrate:up
CREATE OR REPLACE FUNCTION search.subject_ack_windows_v1(step_state text, lo integer, hi integer) RETURNS TABLE(home integer, epoch integer, base bigint, through_pos bigint, receipt text, member text)
    LANGUAGE plpgsql STABLE STRICT
    AS $$
DECLARE body jsonb:=step_state::jsonb->1; input jsonb:=search.public_filter_ack_field(body,'input');
  batch jsonb; ends jsonb; packed bytea; first_no integer; members integer; idx integer;
BEGIN
  IF lo<0 OR hi>4096 OR hi-lo NOT BETWEEN 1 AND 32 THEN RETURN; END IF;
  member:=search.public_filter_ack_field(input,'heldBirth')#>>'{}';
  IF search.public_filter_ack_field(input,'phase')='"window"' OR
    (search.public_filter_ack_field(input,'phase')='"scan"' AND
     search.public_filter_ack_field(input,'heldPageStart')=search.public_filter_ack_field(input,'partition') AND
     search.public_filter_ack_field(body,'scan') IS NOT NULL) THEN
    batch:=search.public_filter_ack_field(body,'windowBatch');
    first_no:=search.public_filter_ack_field(batch,'from')::integer;
    members:=search.public_filter_ack_field(batch,'count')::integer;
    IF search.public_filter_ack_field(batch,'originalCuts')='true' THEN
      IF (members BETWEEN 32 AND 512 AND lo>=first_no AND hi<=first_no+members) IS NOT TRUE THEN RETURN; END IF;
      ends:=(search.public_filter_ack_field(batch,'commandEnds')#>>'{}')::jsonb;
      RETURN QUERY SELECT i,(cut->>'epoch')::integer,(cut->>'command')::bigint,
        coalesce((ends->>i::text)::bigint,(cut->>'command')::bigint),cut->>'receipt',member
        FROM generate_series(lo,hi-1) i CROSS JOIN LATERAL (
          SELECT p.cuts->(i-p.first_home) AS cut FROM semantic.subject_access_page_v1 p
          WHERE (p.birth,p.first_home,p.end_home)=(member::bigint,i/32*32,i/32*32+32) LIMIT 1) x ORDER BY i;
      RETURN;
    END IF;
    packed:=decode(search.public_filter_ack_field(batch,'packed')#>>'{}','base64');
    ends:=search.public_filter_ack_field(batch,'through');
    IF (members BETWEEN 1 AND 128 AND lo>=first_no AND hi<=first_no+members AND
        length(packed)=44*members) IS NOT TRUE THEN RETURN; END IF;
    FOR idx IN lo-first_no..hi-first_no-1 LOOP
      home:=first_no+idx;
      epoch:=('x'||encode(substring(packed FROM 44*idx+1 FOR 4),'hex'))::bit(32)::integer;
      base:=('x'||encode(substring(packed FROM 44*idx+5 FOR 8),'hex'))::bit(64)::bigint;
      through_pos:=CASE WHEN ends IS NULL THEN base ELSE (ends->idx->>1)::bigint END;
      receipt:=encode(substring(packed FROM 44*idx+13 FOR 32),'hex');
      IF epoch>0 AND base>=0 AND through_pos>=base THEN RETURN NEXT; END IF;
    END LOOP;
  ELSIF hi=lo+1 THEN
    RETURN QUERY SELECT lo,w.epoch,w.base,w.through_pos,w.receipt,member FROM search.public_filter_ack_window(step_state,lo) w;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION search.compare_subject_compact_range_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE a search.public_filter_ack_authority; member bigint; def text; window_root text; pages integer; adjacent boolean;
  previous bytea;
BEGIN
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority WHERE job=NEW.job AND phase='reconciled'
    AND pass=1 AND fence IS NULL AND NOT fenced_pass;
  SELECT m.birth,semantic.subject_access_definition_v1(m.birth) INTO STRICT member,def
    FROM core.subject_subscription_v1 m JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced
      AND (m.restore_generation,m.registration_generation)=(d.restore_generation,d.registration_generation)
    CROSS JOIN LATERAL core.subject_retention_heads_v1(NEW.first_home) h
    WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap) AND h.restore=m.restore_generation;
  SELECT root INTO STRICT window_root FROM search.subject_compact_window_v1(a.bootstrap,a.execution,NEW.binding,member,NEW.first_home)
    WHERE stop>=NEW.first_home+NEW.width;
  -- Reopen the finite ends above the original bases. An ordinary later
  -- append still covers the captured end. The page stamps cover rewinds.
  IF EXISTS (
    SELECT FROM (SELECT search.public_filter_ack_field(search.public_filter_ack_field(s.state::jsonb->1,'windowBatch'),
        'commandEnds')#>>'{}' AS ends FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_binding)=(0,a.bootstrap,a.execution,NEW.binding)
        AND s.verified_home<=NEW.first_home AND s.verified_root IS NOT NULL AND NOT s.complete
      ORDER BY s.verified_home DESC LIMIT 1) w
    CROSS JOIN LATERAL jsonb_each_text(w.ends::jsonb) e
    LEFT JOIN LATERAL (SELECT position FROM core.partition WHERE partition_no=e.key::int
      AND position>=e.value::bigint LIMIT 1) h ON true
    WHERE e.key::int>=NEW.first_home AND e.key::int<NEW.first_home+NEW.width AND h.position IS NULL
  ) THEN RAISE EXCEPTION 'Original Subject command end unavailable' USING ERRCODE='40001'; END IF;
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(0,a.registration,a.bootstrap,NEW.first_home,NEW.width) ON CONFLICT DO NOTHING;
  NEW.witness:=search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width,
    search.public_filter_ack_basis_v1(true));
  NEW.bootstrap:=a.bootstrap; NEW.registration:=a.registration; NEW.identity_digest:=a.identity_digest;
  NEW.revision:=gen_random_uuid();
  WITH originals AS (
    SELECT p.first_home,p.predecessor,p.root,lag(p.root) OVER (ORDER BY i) AS prior
    FROM generate_series(NEW.first_home,NEW.first_home+NEW.width-1,32) i
    CROSS JOIN LATERAL (SELECT first_home,predecessor,root FROM search.subject_receiver_page_v1 p
      WHERE (p.birth,p.first_home,p.end_home,p.registration,p.bootstrap)=(member,i,i+32,a.registration,a.bootstrap) LIMIT 1) p
    CROSS JOIN LATERAL (SELECT FROM semantic.subject_access_page_v1 ap WHERE
      (ap.birth,ap.first_home,ap.end_home,ap.definition_digest)=(member,i,i+32,def)
      AND semantic.subject_repair_page_current_v1(ap) LIMIT 1) ap
    CROSS JOIN LATERAL (SELECT FROM core.subject_retention_page_v1 cp
      WHERE (cp.birth,cp.first_home,cp.end_home)=(member,i,i+32) LIMIT 1) cp
  )
  SELECT count(*),bool_and(prior IS NULL OR prior=predecessor),
    max(predecessor) FILTER (WHERE first_home=NEW.first_home),max(root) FILTER (WHERE first_home+32=NEW.first_home+NEW.width),
    sha256(convert_to(jsonb_build_array('subject-receiver-compact/v1',a.job,a.bootstrap,member,NEW.binding,
      a.identity_digest,window_root,NEW.witness,jsonb_agg(to_jsonb(originals) ORDER BY first_home))::text,'UTF8'))
    INTO pages,adjacent,NEW.predecessor,NEW.enrollment_root,NEW.digest FROM originals;
  IF pages<>NEW.width/32 OR adjacent IS NOT TRUE OR def IS NULL THEN
    RAISE EXCEPTION 'Original shared receiver pages unavailable' USING ERRCODE='40001'; END IF;
  SELECT n.digest INTO previous FROM search.public_filter_ack_range n WHERE
    (n.partition_no,n.job,n.binding,n.first_home,n.width,n.witness)=(0,a.job,NEW.binding,NEW.first_home,NEW.width,NEW.witness);
  IF FOUND AND previous IS DISTINCT FROM NEW.digest THEN
    RAISE EXCEPTION 'Conflicting compact receiver range replay' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;

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
    WHILE span>leaf_limit LOOP
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
DO $$ BEGIN RAISE EXCEPTION 'Retained Subject command ranges require forward migration'; END $$;
