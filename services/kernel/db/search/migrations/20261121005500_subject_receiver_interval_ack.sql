-- migrate:up
-- Decode the packed original once per verified Source step. A single-home
-- creation bridge keeps the previous replay decoder.
CREATE OR REPLACE FUNCTION search.subject_ack_windows_v1(step_state text,lo integer,hi integer)
RETURNS TABLE(home integer,epoch integer,base bigint,through_pos bigint,receipt text,member text)
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
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

CREATE OR REPLACE FUNCTION search.compare_subject_receiver_leaf_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a search.public_filter_ack_authority; previous search.public_filter_ack_range; homes integer; adjacent boolean;
BEGIN
  IF NEW.partition_no<>0 OR NEW.width NOT IN (1,2,4,8,16,32) OR NEW.first_home<0
    OR NEW.first_home+NEW.width>4096 OR NEW.first_home%NEW.width<>0 THEN
    RAISE EXCEPTION 'Invalid shared receiver interval' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT a FROM search.public_filter_ack_authority
    WHERE job=NEW.job AND phase='reconciled' AND pass=1 AND NOT fenced_pass AND fence IS NULL;
  NEW.registration:=a.registration; NEW.bootstrap:=a.bootstrap; NEW.revision:=gen_random_uuid();
  NEW.identity_digest:=a.identity_digest;
  INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
    VALUES(0,a.registration,a.bootstrap,NEW.first_home/greatest(NEW.width,16)*greatest(NEW.width,16),greatest(NEW.width,16))
    ON CONFLICT DO NOTHING;
  NEW.witness:=search.public_filter_ack_range_witness(a.bootstrap,NEW.first_home,NEW.width,
    search.public_filter_ack_witness(ARRAY['','@ack-retention','@accounts','@source']));
  WITH member AS MATERIALIZED (
    SELECT m.birth,m.restore_generation,semantic.subject_access_definition_v1(m.birth) AS definition_digest
    FROM core.subject_subscription_v1 m JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced
      AND (d.restore_generation,d.registration_generation)=(m.restore_generation,m.registration_generation)
    CROSS JOIN LATERAL core.subject_retention_heads_v1(NEW.first_home) h
    WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap) AND h.restore=m.restore_generation
  ), steps AS MATERIALIZED (
    (SELECT s.verified_home,s.state,s.verified_root FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_binding)=(0,a.bootstrap,a.execution,NEW.binding)
        AND s.verified_home<=NEW.first_home AND s.verified_root IS NOT NULL AND NOT s.complete
      ORDER BY s.verified_home DESC LIMIT 1)
    UNION ALL
    SELECT s.verified_home,s.state,s.verified_root FROM semantic.public_filter_repair_step s
      WHERE (s.partition_no,s.bootstrap,s.execution,s.verified_binding)=(0,a.bootstrap,a.execution,NEW.binding)
        AND s.verified_home>NEW.first_home AND s.verified_home<NEW.first_home+NEW.width
        AND s.verified_root IS NOT NULL AND NOT s.complete
  ), windows AS (
    SELECT steps.*,lead(verified_home,1,NEW.first_home+NEW.width) OVER (ORDER BY verified_home) AS end_home FROM steps
  ), pages AS MATERIALIZED (
    SELECT m.birth,m.restore_generation,p.first_home,p.end_home,p.cuts,ap.cuts AS source_cuts,cp.cuts AS core_cuts
    FROM member m CROSS JOIN LATERAL (
      (SELECT p.* FROM search.subject_receiver_page_v1 p WHERE p.birth=m.birth AND p.first_home<=NEW.first_home
        ORDER BY p.first_home DESC LIMIT 1)
      UNION ALL SELECT p.* FROM search.subject_receiver_page_v1 p WHERE p.birth=m.birth AND
        p.first_home>NEW.first_home AND p.first_home<NEW.first_home+NEW.width
    ) p JOIN semantic.subject_access_page_v1 ap ON (ap.birth,ap.first_home,ap.end_home,ap.definition_digest)=
      (p.birth,p.first_home,p.end_home,m.definition_digest)
    JOIN core.subject_retention_page_v1 cp ON (cp.birth,cp.first_home,cp.end_home)=(p.birth,p.first_home,p.end_home)
    WHERE (p.registration,p.bootstrap)=(a.registration,a.bootstrap) AND
      semantic.subject_access_range_current_v1(ap,greatest(p.first_home,NEW.first_home),least(p.end_home,NEW.first_home+NEW.width))
  ), compared AS (
    SELECT i.home,win.receipt,step.verified_root,win.through_pos,base.cut->>'predecessor' AS predecessor,
      base.cut->>'root' AS root,lag(base.cut->>'root') OVER (ORDER BY i.home) AS prior
    FROM windows step CROSS JOIN LATERAL search.subject_ack_windows_v1(
      step.state,greatest(NEW.first_home,step.verified_home),step.end_home) win
    JOIN pages p ON win.home>=p.first_home AND win.home<p.end_home AND win.member=p.birth::text
    CROSS JOIN LATERAL (SELECT win.home) i
    CROSS JOIN LATERAL (SELECT p.cuts->(i.home-p.first_home) AS cut,p.source_cuts->(i.home-p.first_home) AS src,
      p.core_cuts->(i.home-p.first_home) AS original) base
    CROSS JOIN LATERAL (SELECT epoch,position FROM core.partition WHERE partition_no=i.home AND write_state='active' LIMIT 1) h
    CROSS JOIN LATERAL (SELECT generation FROM core.publication_authority_epoch WHERE home_no=i.home LIMIT 1) g
    CROSS JOIN LATERAL (SELECT position FROM semantic.public_filter_privacy_head WHERE partition_no=i.home
      AND owner_epoch=h.epoch AND NOT population_fenced LIMIT 1) n
    LEFT JOIN core.subject_cleanup_v1 permit ON permit.home=i.home
    WHERE base.src @> base.original AND base.cut-'root'-'predecessor'=base.src-'account'-'claim'
      AND (base.cut->>'home',base.cut->>'epoch',base.cut->>'generation')=(i.home::text,h.epoch::text,g.generation::text)
      AND (win.base,win.receipt,win.epoch)=((base.cut->>'command')::bigint,base.cut->>'receipt',h.epoch)
      AND h.position>=win.through_pos AND n.position>=(base.cut->>'privacy')::bigint
      AND (permit.home IS NULL OR ((permit.owner_epoch,permit.home_generation,permit.restore_generation)=(h.epoch,g.generation,p.restore_generation)
        AND permit.command_through<=win.base AND permit.privacy_through<=(base.cut->>'privacy')::bigint))

  )
  SELECT count(*),bool_and(prior IS NULL OR prior=predecessor),
    max(predecessor) FILTER (WHERE home=NEW.first_home),max(root) FILTER (WHERE home=NEW.first_home+NEW.width-1),
    sha256(convert_to(jsonb_build_array('subject-receiver-leaf/v1',a.job,a.bootstrap,NEW.binding,a.identity_digest,
      jsonb_agg(to_jsonb(compared) ORDER BY home))::text,'UTF8'))
    INTO homes,adjacent,NEW.predecessor,NEW.enrollment_root,NEW.digest FROM compared;
  IF homes<>NEW.width OR adjacent IS NOT TRUE THEN
    RAISE EXCEPTION 'Original shared receiver window unavailable' USING ERRCODE='40001'; END IF;
  SELECT * INTO previous FROM search.public_filter_ack_range
    WHERE (partition_no,job,binding,first_home,width,witness)=(0,a.job,NEW.binding,NEW.first_home,NEW.width,NEW.witness);
  IF FOUND AND previous.digest IS DISTINCT FROM NEW.digest THEN
    RAISE EXCEPTION 'Conflicting shared receiver window replay' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;

-- Before the terminal window, compare the latest complete leaf once. A
-- later writer can change its witness while the rest of Source is still
-- running. Only the final current-witness tree can use that leaf for serving.
CREATE FUNCTION search.prepare_subject_ack_prefix_v1(job_id uuid,key_limit integer,byte_limit integer)
RETURNS TABLE(points integer, proof_bytes integer, range_writes integer, result_writes integer)
LANGUAGE plpgsql AS $$
DECLARE a search.public_filter_ack_authority; chain text; available integer; leaf integer;
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
  IF available=4096 THEN
    -- The final root includes every current leaf and its ordered parents.
    IF key_limit>=204 AND byte_limit>=106496 THEN
      RETURN QUERY SELECT p.points+24,p.proof_bytes+16384,p.range_writes,p.result_writes
        FROM search.prepare_public_filter_ack_batch(job_id,key_limit-24,byte_limit-16384) p;
      RETURN;
    END IF;
  ELSIF available>=32 AND key_limit>=800 AND byte_limit>=851968 THEN
    leaf:=available/32*32-32;
    IF NOT EXISTS (SELECT FROM search.public_filter_ack_range n
      WHERE (n.partition_no,n.job,n.binding,n.first_home,n.width)=(0,job_id,chain,leaf,32)) THEN
      INSERT INTO search.public_filter_ack_home_clock(partition_no,registration,bootstrap,first_home,width)
        VALUES(0,a.registration,a.bootstrap,leaf,32) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS result_writes=ROW_COUNT;
      INSERT INTO search.public_filter_ack_range(partition_no,job,binding,first_home,width)
        VALUES(0,job_id,chain,leaf,32) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS range_writes=ROW_COUNT;
      result_writes:=result_writes+range_writes;
      points:=800; proof_bytes:=851968;
    END IF;
  END IF;
  RETURN NEXT;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained Subject interval ACKs require forward migration'; END $$;
