-- migrate:up
-- Resolve each verified range once. The packed window still has to admit the exact
-- interior home before the receiver compares its original and native authorities.
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
    SELECT m.birth,semantic.subject_access_definition_v1(m.birth) AS definition_digest
    FROM core.subject_subscription_v1 m WHERE (m.job,m.bootstrap)=(a.job,a.bootstrap)
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
  ), compared AS (
    SELECT i.home,win.receipt,step.verified_root,win.through_pos,base.cut->>'predecessor' AS predecessor,
      base.cut->>'root' AS root,lag(base.cut->>'root') OVER (ORDER BY i.home) AS prior
    FROM member m CROSS JOIN windows step
    CROSS JOIN LATERAL generate_series(greatest(NEW.first_home,step.verified_home),step.end_home-1) i(home)
    CROSS JOIN LATERAL (SELECT * FROM search.subject_receiver_page_v1 p
      WHERE p.birth=m.birth AND p.first_home<=i.home ORDER BY p.first_home DESC LIMIT 1) p
    JOIN semantic.subject_access_page_v1 ap ON (ap.birth,ap.first_home,ap.end_home,ap.definition_digest)=
      (p.birth,p.first_home,p.end_home,m.definition_digest)
    JOIN core.subject_retention_page_v1 cp ON (cp.birth,cp.first_home,cp.end_home)=(p.birth,p.first_home,p.end_home)
    CROSS JOIN LATERAL (SELECT p.cuts->(i.home-p.first_home) AS cut,ap.cuts->(i.home-p.first_home) AS src,
      cp.cuts->(i.home-p.first_home) AS original) base
    CROSS JOIN LATERAL search.public_filter_ack_window(step.state,i.home) win
    CROSS JOIN LATERAL core.subject_retention_heads_v1(i.home) h
    CROSS JOIN LATERAL semantic.subject_access_heads_v1(i.home,h.epoch) acc
    LEFT JOIN core.subject_cleanup_v1 permit ON permit.home=i.home
    WHERE (p.registration,p.bootstrap)=(a.registration,a.bootstrap) AND i.home<p.end_home
      AND base.src @> base.original AND base.cut-'root'-'predecessor'=base.src-'account'-'claim'
      AND (base.cut->>'home',base.cut->>'epoch',base.cut->>'generation')=(i.home::text,h.epoch::text,h.generation::text)
      AND (win.base,win.receipt,win.epoch)=((base.cut->>'command')::bigint,base.cut->>'receipt',h.epoch)
      AND h.command_base>=win.through_pos AND h.privacy_base>=(base.cut->>'privacy')::bigint
      AND acc.account_revision>=(base.src->>'account')::bigint AND acc.claim_revision>=(base.src->>'claim')::bigint
      AND (acc.enqueue_revision>(base.src->>'enqueue')::bigint OR (acc.enqueue_revision,acc.account_revision,acc.claim_revision)=
        ((base.src->>'enqueue')::bigint,(base.src->>'account')::bigint,(base.src->>'claim')::bigint))
      AND (permit.home IS NULL OR ((permit.owner_epoch,permit.home_generation,permit.restore_generation)=(h.epoch,h.generation,h.restore)
        AND permit.command_through<=win.base AND permit.privacy_through<=(base.cut->>'privacy')::bigint))
      AND search.public_filter_ack_field(search.public_filter_ack_field(step.state::jsonb->1,'input'),'heldBirth')#>>'{}'=p.birth::text
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

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained held Subject repair windows require forward migration'; END $$;
