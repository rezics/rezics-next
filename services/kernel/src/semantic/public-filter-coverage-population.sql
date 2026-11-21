/* semantic.privacy-role */
WITH width AS (SELECT $5::integer AS plans,$1::jsonb AS members), input AS MATERIALIZED (
  SELECT m.*,$2::bigint AS now,$3::text AS route_digest,$4::text[] AS catalogue_text_keys
  -- Composed Book pages have their own statement. This role binds exactly one observation.
  FROM width w CROSS JOIN LATERAL jsonb_to_record(w.members->0) m(slot integer,observation text,queried text,consumer text,
    physical_target text,incarnation text,execution_id text,start_id uuid,deadline bigint,page_id uuid,
    publication_job uuid,publication_bootstrap uuid,terminal_step uuid,terminal_root text)
  WHERE w.plans=1 AND jsonb_array_length(w.members)=1
),
binding AS MATERIALIZED (
  SELECT i.slot,i.execution_id,i.start_id AS requested_start,i.deadline,o.partition_no,o.observation,o.registration,o.queried,o.covered,
    r.consumer,r.definition,coalesce(attached.generation,r.coverage_generation) AS coverage_generation,
    t.incarnation,b.bootstrap,b.book_withdrawals,b.read_definition,b.consumer AS bootstrap_consumer,
    b.snapshot_kind,b.coverage_generation AS covered_generation,coalesce(attached.coverage_root,b.coverage_root) AS coverage_root,
    coalesce(attached.bootstrap,b.bootstrap) AS coverage_bootstrap,
    coalesce(attached.registration,o.registration) AS coverage_registration,
    d.coverage_keys || coalesce(attached.coverage_keys,'{}'::text[])
      || CASE WHEN (attached.job IS NOT NULL AND r.physical_target !~ 'discovery-g[1-9][0-9]*$') OR '["scope","catalogue-text"]'=ANY(d.coverage_keys)
         THEN i.catalogue_text_keys ELSE '{}'::text[] END AS pending_keys,
    s.source_id,s.configuration,s.owner_epoch,s.route_digest,
    d.release_digest,d.capture,d.dependency_keys,d.coverage_keys,
    e.execution,e.consumer_window,st.id AS start_id,st.start_generation,st.deadline AS start_deadline,
    pg.id AS page_id,pg.state AS page_state,pg.rounds AS page_rounds,pg.boundary,pg.boundary_consumed,pg.boundary_window,
    pg.charged AS page_charged,pg.ceiling AS page_ceiling,pg.tail AS page_tail,pg.tail_consumed
  FROM input i JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,i.observation)
  JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
  JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
  JOIN semantic.public_filter_bootstrap b ON b.partition_no=0 AND b.bootstrap=
    CASE WHEN o.consumer_bootstrap ~ '^0:[0-9a-f-]{36}$' THEN substr(o.consumer_bootstrap,3)::uuid END
  JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(b.partition_no,b.read_definition)
  JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=
    (d.partition_no,d.source_id,d.configuration)
  JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=s.owner_epoch AND p.write_state='active'
  LEFT JOIN LATERAL (
    /* semantic.attached-coverage */
    SELECT proof.* FROM semantic.public_filter_published_coverage(
      r.physical_target,t.incarnation,b.read_definition,b.coverage_publication,i.catalogue_text_keys
    ) proof WHERE b.coverage_publication IS NOT NULL AND r.physical_target !~ 'discovery-g[1-9][0-9]*$'
    /* semantic.end-attached-coverage */
  ) attached ON true
  JOIN LATERAL (
    SELECT * FROM search.public_filter_coverage_preparation c
    WHERE (c.partition_no,c.registration,c.bootstrap)=
      (o.partition_no,coalesce(attached.registration,o.registration),coalesce(attached.bootstrap,b.bootstrap))
    LIMIT 1
  ) c ON true
  JOIN search.public_filter_coverage_baseline last_home ON
    (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=
    (c.partition_no,c.registration,c.bootstrap,4095) AND last_home.root=c.root
  LEFT JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=
    (o.partition_no,o.observation,i.execution_id)
  LEFT JOIN semantic.public_filter_population_start st ON st.partition_no=o.partition_no AND st.id=i.start_id
  LEFT JOIN search.public_filter_coverage_page pg ON (pg.partition_no,pg.id)=
    (o.partition_no,coalesce(i.page_id,e.page_id))
  LEFT JOIN search.public_filter_reference f ON (f.partition_no,f.observation,f.token)=
    (pg.partition_no,pg.observation,pg.reference_token) AND f.expires_at>i.now
  WHERE ((SELECT plans FROM width)=1 OR (pg.id IS NOT NULL AND pg.deadline=i.deadline AND pg.deadline>i.now
      AND b.snapshot_kind='pit' AND b.coverage_publication IS NOT NULL
      AND semantic.public_filter_native_json(d.capture::jsonb)->'bookTypeList'='true'::jsonb))
    AND o.state='open' AND o.expires_at>i.now AND o.queried=i.queried
    AND r.state='active' AND r.consumer=i.consumer AND r.physical_target=i.physical_target AND t.incarnation=i.incarnation
    AND b.state='adopted' AND b.queried=o.observation AND b.owner_epoch=p.epoch AND b.coverage_generation IS NOT NULL
    AND c.after_home=4096 AND c.population_protocol=1
    AND (
      (b.coverage_publication IS NULL AND b.account_after=4096 AND b.coverage_sealed AND b.coverage_after=4096
       AND c.root=b.coverage_root AND c.generation=b.coverage_generation AND c.definition=d.read_definition AND c.consumer=r.consumer
       AND (c.ack_protocol=0 OR EXISTS (
         SELECT FROM semantic.public_filter_ack_origin(r.id,b.bootstrap) m
         WHERE (m.job,m.observation,m.execution,m.ack_after)=(b.publication_job,o.observation,b.publication_execution,4096)
       )))
      OR (attached.job=b.coverage_publication AND attached.generation>=b.coverage_generation
          AND b.coverage_generation>=attached.covered_generation
          AND c.root=attached.coverage_root AND c.generation=attached.covered_generation
          AND c.definition=attached.definition AND c.consumer=attached.consumer)
    )
    AND s.route_digest=i.route_digest AND d.coverage_keys IS NOT NULL
    AND (EXISTS (SELECT 1 FROM semantic.definition_release WHERE route=0 AND digest=d.release_digest)
      OR EXISTS (SELECT 1 FROM semantic.release_composite WHERE digest=d.release_digest))
    AND (
      (i.publication_job IS NULL AND (i.execution_id IS NULL OR
        (e.id IS NOT NULL AND st.id IS NOT NULL
         AND (st.registration,st.observation,st.bootstrap,st.read_definition,st.consumer,
              st.covered_generation,st.owner_epoch)=
             (o.registration,o.observation,b.bootstrap,b.read_definition,r.consumer,b.coverage_generation,p.epoch))))
      OR EXISTS (
        SELECT 1 FROM semantic.public_filter_repair_step seal
        WHERE (seal.partition_no,seal.bootstrap,seal.execution,seal.step)=(0,b.bootstrap,e.id,i.terminal_step)
        AND i.publication_job=b.publication_job AND i.publication_bootstrap=b.bootstrap
          AND b.publication_observation=o.observation AND b.publication_execution=e.id
          AND b.snapshot_kind='prepared' AND e.page_id IS NULL AND e.consumer_window IS NULL
          AND seal.complete AND seal.verified_root=i.terminal_root AND seal.verified_next IS NULL AND seal.ack_after=4096
      )
    )
    AND ((pg.id IS NULL AND i.page_id IS NULL AND e.page_id IS NULL)
      OR ((pg.observation,pg.registration,pg.definition,pg.consumer)=
        (o.observation,o.registration,r.definition,r.consumer)
        AND f.token IS NOT NULL
        AND ((i.execution_id IS NULL AND pg.id=i.start_id
          AND pg.state='planned' AND pg.deadline=i.deadline AND pg.rounds=0 AND pg.pending IS NULL)
        OR (i.execution_id IS NOT NULL AND pg.id=st.id AND pg.state IN ('sealed','finished')
          AND pg.pending IS NULL AND pg.tail=e.id AND pg.tail_consumed IS NOT NULL AND pg.rounds BETWEEN 1 AND 3))))
), scopes AS MATERIALIZED (
  -- Compare the controls resolved from every immutable child. In particular, a
  -- newer covered cut or a different withdrawal proof cannot stand in for an older one.
  SELECT DISTINCT partition_no,coverage_registration,coverage_bootstrap,coverage_root,coverage_generation,owner_epoch,
    covered_generation,start_generation,book_withdrawals,pending_keys,
    least(covered_generation,coalesce(start_generation,covered_generation)) AS since
  FROM binding
), population AS MATERIALIZED (
  SELECT scope.* FROM scopes scope WHERE (SELECT count(*) FROM scopes)=1
    AND (SELECT count(*) FROM binding)=(SELECT plans FROM width)
    -- Book PIT plans retain min(600,6*slots+3), whose integer quotient by six is slots.
    AND ((SELECT plans FROM width)=1 OR (SELECT sum(page_ceiling/6) FROM binding)<=$6::integer)
    -- A withdrawn ID can be completely absent from the PIT. Its original home
    -- still participates in the independent start and final owner checks.
    /* semantic.book-withdrawals */
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(scope.book_withdrawals) w(home integer,epoch integer,route integer,id uuid,visibility text,revision text)
      LEFT JOIN core.partition owner ON owner.partition_no=w.home
      LEFT JOIN semantic.public_filter_privacy_head n ON n.partition_no=w.home
      LEFT JOIN semantic.subject s ON (s.route,s.subject_id)=(w.route,w.id)
      WHERE owner.write_state IS DISTINCT FROM 'active' OR owner.epoch IS DISTINCT FROM w.epoch
        OR n.owner_epoch IS DISTINCT FROM w.epoch OR n.population_fenced IS DISTINCT FROM false
        OR s.visibility IS DISTINCT FROM w.visibility OR s.security_revision::text IS DISTINCT FROM w.revision
    )
    /* semantic.end-book-withdrawals */
), pending AS MATERIALIZED (
  -- The exact complete compiler closure is persisted by the original definition
  -- writer. LIMIT precedes every receiver-summary or own-row lookup.
  SELECT partition_no FROM semantic.public_filter_privacy_pending
  WHERE live AND input_key=ANY((SELECT pending_keys FROM population)::text[]) LIMIT 1
), fenced AS MATERIALIZED (
  SELECT partition_no FROM semantic.public_filter_privacy_head
  WHERE population_fenced AND NOT EXISTS(SELECT 1 FROM pending) LIMIT 1
), behind AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch FROM population b
  CROSS JOIN LATERAL (
    SELECT source_home,source_epoch FROM semantic.public_filter_effective_homes(
      b.coverage_registration,b.coverage_bootstrap,NULL,CASE WHEN b.book_withdrawals IS NULL THEN 1 ELSE 9 END) h
    WHERE semantic.public_filter_book_withdrawal_covers(h,b.coverage_bootstrap,b.book_withdrawals) IS NOT TRUE
    ORDER BY source_home LIMIT 1
  ) h WHERE NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
), changed AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch FROM population b
  CROSS JOIN LATERAL (
    SELECT source_home,source_epoch FROM search.public_filter_coverage_home h
    WHERE (h.partition_no,h.registration)=(b.partition_no,b.coverage_registration)
      AND h.last_change_generation>b.since
    ORDER BY last_change_generation,source_home LIMIT 1
  ) h WHERE NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
    AND NOT EXISTS(SELECT 1 FROM behind)
), heads AS MATERIALIZED (
  SELECT 'pending'::text AS phase,h.source_home,h.source_epoch,
    n.owner_epoch AS current_epoch,n.position::text,n.population_fenced
  FROM behind h LEFT JOIN semantic.public_filter_privacy_head n ON n.partition_no=h.source_home
  UNION ALL
  SELECT 'changed',h.source_home,h.source_epoch,n.owner_epoch,n.position::text,n.population_fenced
  FROM changed h LEFT JOIN semantic.public_filter_privacy_head n ON n.partition_no=h.source_home
)
/* semantic.own-window */
, checked AS MATERIALIZED (
  SELECT b.*,checks.* FROM binding b CROSS JOIN LATERAL (
    WITH member AS MATERIALIZED (SELECT b.*),
    children AS MATERIALIZED (
      -- Separate exact-key paths: never enumerate the observation's prior history.
      SELECT * FROM (
        SELECT e.id,e.execution,e.consumer_window,e.page_ordinal,e.page_parent,e.page_consumed,e.page_size,e.page_raw,e.page_status
        FROM member b JOIN search.public_filter_execution e ON (e.partition_no,e.page_id)=(b.partition_no,b.page_id)
        WHERE b.page_id IS NOT NULL AND (SELECT execution_id FROM member) IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced) AND NOT EXISTS(SELECT 1 FROM heads)
        UNION ALL
        SELECT e.id,e.execution,e.consumer_window,e.page_ordinal,e.page_parent,e.page_consumed,e.page_size,e.page_raw,e.page_status
        FROM member b JOIN search.public_filter_execution e ON
          (e.partition_no,e.observation,e.id)=(b.partition_no,b.observation,(SELECT execution_id FROM member))
        WHERE b.page_id IS NULL AND (SELECT execution_id FROM member) IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced) AND NOT EXISTS(SELECT 1 FROM heads)
      ) actual ORDER BY page_ordinal LIMIT 3
    ), decoded AS MATERIALIZED (
      SELECT b.*,c.id AS child_id,c.page_ordinal,c.page_parent,c.page_consumed,c.page_size,c.page_status,
        semantic.public_filter_native_json(c.execution::jsonb) AS execution_value,
        semantic.public_filter_native_json(c.consumer_window::jsonb) AS window_value
      FROM member b CROSS JOIN children c
    ), decoded_own AS MATERIALIZED (
      -- Every original and terminal participates, including rejects and repeats.
      -- Decode the entire retained window before admitting any keyed control. Repeats
      -- remain in execution/raw accounting; a native control at this ONE snapshot is
      -- read once per exact key, rather than twice for every repeated original.
      SELECT k.id,b.coverage_bootstrap AS bootstrap,b.partition_no,b.coverage_registration AS registration,
        coalesce(raw.key->>'owner'='accounts',false) AS account,
        coalesce((raw.key->>'owner',raw.key->>'kind') IN
          (('commerce','collection'),('content','review'),('content','space'))
          AND raw.key->>'kind'=r.value->>'metadataKind'
          AND raw.key->>'id'=r.value->>'original' AND r.value->>'original'=r.value->>'terminal',false) AS metadata
      FROM decoded b CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(b.execution_value->'ownRows')='array' THEN b.execution_value->'ownRows' ELSE '[]'::jsonb END
      ) WITH ORDINALITY r(value,ordinality)
      CROSS JOIN LATERAL (VALUES (b.window_value->'raw'->(r.ordinality::integer-1)->'key')) raw(key)
      CROSS JOIN LATERAL (VALUES (r.value->>'original'),(r.value->>'terminal')) k(id)
    ), own_keys AS MATERIALIZED (
      SELECT DISTINCT id,account,bootstrap,partition_no,registration,
        CASE WHEN id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (('x'||substr(id,25,4))::bit(16)::integer >> 4) END AS source_home
      -- The retained mixed consumer rechecks metadata through the matching native owner at finish.
      -- Only Subject and Account keys address the controls below.
      FROM decoded_own WHERE NOT metadata
    ), home_keys AS MATERIALIZED (
      SELECT DISTINCT bootstrap,partition_no,registration,source_home FROM own_keys
    ), budgeted AS MATERIALIZED (
      -- Reserve the actual distinct composite keys, including misses, before either
      -- native control relation is dispatched. No accepted prefix of an oversized
      -- window can become authority. The raw window itself remains fully charged.
      SELECT * FROM member WHERE (SELECT execution_id FROM member) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM decoded WHERE jsonb_typeof(execution_value->'ownRows') IS DISTINCT FROM 'array')
        AND (SELECT count(*) FROM decoded)=coalesce(page_rounds,1)
        AND NOT EXISTS (SELECT 1 FROM decoded WHERE page_id IS NOT NULL AND page_status IS DISTINCT FROM 'complete')
        AND NOT EXISTS (SELECT 1 FROM own_keys WHERE source_home IS NULL)
        AND 64+4*coalesce(jsonb_array_length(book_withdrawals),0)+cardinality(coverage_keys)+5*(SELECT count(*) FROM home_keys)
          +(CASE WHEN book_withdrawals IS NULL THEN 2 ELSE 6 END)*(SELECT count(*) FROM own_keys WHERE NOT account)<=1000
    ), home_control AS MATERIALIZED (
      SELECT h.source_home,n.owner_epoch,n.population_fenced,base.source_epoch,
        base.native_revision,base.native_claim_revision,base.source_position
      FROM home_keys h CROSS JOIN budgeted b
      -- Drive all three point reads from the deduplicated window, including missing keys.
      LEFT JOIN LATERAL (
        SELECT source_epoch,native_revision,native_claim_revision,source_position
        FROM search.public_filter_coverage_baseline base
        WHERE (base.partition_no,base.registration,base.bootstrap,base.source_home)=
          (h.partition_no,h.registration,h.bootstrap,h.source_home)
        OFFSET 0
      ) base ON true
      LEFT JOIN LATERAL (
        SELECT owner_epoch,population_fenced FROM semantic.public_filter_privacy_head n
        WHERE n.partition_no=h.source_home OFFSET 0
      ) n ON true
    ), subject_control AS MATERIALIZED (
      SELECT k.id,k.source_home,v.route,v.position,v.owner_epoch AS subject_epoch,h.source_epoch,h.source_position,
        b.book_withdrawals @> jsonb_build_array(jsonb_build_object('id',k.id)) AS withdrawn
      FROM own_keys k CROSS JOIN budgeted b JOIN home_control h ON h.source_home=k.source_home
      LEFT JOIN LATERAL (
        SELECT route,position,owner_epoch FROM semantic.public_filter_privacy_subject v
        WHERE (v.partition_no,v.subject_id)=(k.source_home,k.id::uuid) OFFSET 0
      ) v ON true
      WHERE NOT k.account
    ), admitted AS MATERIALIZED (
      SELECT b.* FROM member b WHERE NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
        AND NOT EXISTS(SELECT 1 FROM heads) AND ((SELECT execution_id FROM member) IS NULL
          OR EXISTS(SELECT 1 FROM budgeted))
        AND NOT EXISTS(SELECT 1 FROM home_control WHERE source_epoch IS NULL OR owner_epoch IS NULL
          OR population_fenced OR source_epoch<>owner_epoch)
        AND NOT EXISTS(SELECT 1 FROM own_keys k JOIN home_control h ON h.source_home=k.source_home
          WHERE k.account AND (h.native_revision IS NULL OR h.native_claim_revision IS NULL))
        AND NOT EXISTS(SELECT 1 FROM subject_control WHERE withdrawn OR position IS NULL OR subject_epoch IS NULL
          OR subject_epoch<>source_epoch OR (position>source_position AND NOT EXISTS (
            -- Creation seeds the current home privacy position even for a new ID.
            -- Only its original birth after the proven withdrawal can explain that position.
            SELECT 1 FROM jsonb_to_recordset(b.book_withdrawals) w(home integer,epoch integer,"position" bigint,command bigint)
            JOIN semantic.subject s ON (s.route,s.subject_id)=(subject_control.route,subject_control.id::uuid)
            JOIN editorial.write_basis birth ON (birth.partition_no,birth.transaction_id)=(w.home,s.recorded_transaction_id)
            WHERE (w.home,w.epoch,w.position)=(subject_control.source_home,subject_epoch,subject_control.position)
              AND birth.epoch=w.epoch AND birth.position>w.command
          )))
    )
    SELECT EXISTS(SELECT 1 FROM admitted) AS admitted,
      coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.page_ordinal) FROM children c),'[]'::jsonb) AS page_children,
      (SELECT count(*)::integer FROM home_control) AS own_homes,
      (SELECT count(*)::integer FROM subject_control) AS own_subjects,
      (SELECT count(*)::integer FROM subject_control WHERE b.book_withdrawals IS NOT NULL AND position>source_position) AS own_births
  ) checks WHERE EXISTS (SELECT 1 FROM population)
), inserted AS (
  INSERT INTO semantic.public_filter_population_start
    (partition_no,id,registration,observation,bootstrap,read_definition,consumer,
     covered_generation,start_generation,owner_epoch,deadline)
  SELECT partition_no,requested_start,registration,observation,bootstrap,read_definition,consumer,
    covered_generation,coverage_generation,owner_epoch,deadline FROM checked WHERE admitted AND execution_id IS NULL
  RETURNING id
), started_page AS (
  UPDATE search.public_filter_coverage_page pg SET state='open',revision=revision+1
  FROM inserted i WHERE (pg.partition_no,pg.id)=(0,i.id) AND pg.state='planned'
  RETURNING pg.id
), finished_page AS (
  UPDATE search.public_filter_coverage_page pg SET state='finished',revision=revision+1
  FROM checked b WHERE (pg.partition_no,pg.id)=(b.partition_no,b.page_id)
    AND b.admitted AND b.execution_id IS NOT NULL AND pg.state='sealed'
  RETURNING pg.id
)
SELECT b.*,EXISTS(SELECT 1 FROM pending) AS pending,EXISTS(SELECT 1 FROM fenced) AS fenced,
  i.id::text AS inserted_start,s.id::text AS started_page,f.id::text AS finished_page,
  coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM heads h),'[]'::jsonb) AS heads
FROM checked b LEFT JOIN inserted i ON i.id=b.requested_start
LEFT JOIN started_page s ON s.id=b.page_id LEFT JOIN finished_page f ON f.id=b.page_id
ORDER BY b.slot;
