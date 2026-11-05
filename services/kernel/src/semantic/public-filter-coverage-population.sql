/* semantic.privacy-role */
WITH input AS MATERIALIZED (SELECT $5::bigint AS now,$9::text AS execution_id,$10::uuid AS start_id,$11::bigint AS deadline,$12::uuid AS page_id),
binding AS MATERIALIZED (
  SELECT o.partition_no,o.observation,o.registration,o.queried,o.covered,
    r.consumer,r.definition,r.coverage_generation,
    t.incarnation,b.bootstrap,b.read_definition,b.consumer AS bootstrap_consumer,
    b.snapshot_kind,b.coverage_generation AS covered_generation,b.coverage_root,
    s.source_id,s.configuration,s.owner_epoch,s.route_digest,
    d.release_digest,d.subject_type,d.capture,d.dependency_keys,d.coverage_keys,
    e.execution,e.consumer_window,st.id AS start_id,st.start_generation,st.deadline AS start_deadline,
    pg.id AS page_id,pg.state AS page_state,pg.rounds AS page_rounds,pg.boundary,pg.boundary_consumed,pg.boundary_window,
    pg.charged AS page_charged,pg.ceiling AS page_ceiling,pg.tail AS page_tail,pg.tail_consumed
  FROM search.public_filter_observation o
  JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
  JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
  JOIN semantic.public_filter_bootstrap b ON b.partition_no=0 AND b.bootstrap=
    CASE WHEN o.consumer_bootstrap ~ '^0:[0-9a-f-]{36}$' THEN substr(o.consumer_bootstrap,3)::uuid END
  JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(b.partition_no,b.read_definition)
  JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=
    (d.partition_no,d.source_id,d.configuration)
  JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=s.owner_epoch AND p.write_state='active'
  JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=
    (o.partition_no,o.registration,b.bootstrap)
  JOIN search.public_filter_coverage_baseline last_home ON
    (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=
    (c.partition_no,c.registration,c.bootstrap,4095) AND last_home.root=c.root
  LEFT JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=
    (o.partition_no,o.observation,(SELECT execution_id FROM input))
  LEFT JOIN semantic.public_filter_population_start st ON st.partition_no=o.partition_no AND st.id=(SELECT start_id FROM input)
  LEFT JOIN search.public_filter_coverage_page pg ON (pg.partition_no,pg.id)=
    (o.partition_no,coalesce((SELECT page_id FROM input),e.page_id))
  LEFT JOIN search.public_filter_reference f ON (f.partition_no,f.observation,f.token)=
    (pg.partition_no,pg.observation,pg.reference_token) AND f.expires_at>(SELECT now FROM input)
  WHERE (o.partition_no,o.observation)=($1::integer,$2::text) AND o.partition_no=0
    AND o.state='open' AND o.expires_at>(SELECT now FROM input) AND o.queried=$3::text
    AND r.state='active' AND r.consumer=$4::text AND r.physical_target=$6::text AND t.incarnation=$7::text
    AND b.state='adopted' AND b.queried=o.observation AND b.owner_epoch=p.epoch AND b.account_after=4096 AND b.coverage_sealed
    AND b.coverage_after=4096 AND b.coverage_generation IS NOT NULL
    AND c.after_home=4096 AND c.population_protocol=1 AND c.root=b.coverage_root
    AND c.generation=b.coverage_generation AND c.definition=d.read_definition AND c.consumer=r.consumer
    AND s.route_digest=$8::text AND d.coverage_keys IS NOT NULL
    AND (EXISTS (SELECT 1 FROM semantic.definition_release WHERE route=0 AND digest=d.release_digest)
      OR EXISTS (SELECT 1 FROM semantic.release_composite WHERE digest=d.release_digest))
    AND ((SELECT execution_id FROM input) IS NULL OR (e.id IS NOT NULL AND st.id IS NOT NULL
      AND (st.registration,st.observation,st.bootstrap,st.read_definition,st.consumer,
           st.covered_generation,st.owner_epoch)=
          (o.registration,o.observation,b.bootstrap,b.read_definition,r.consumer,b.coverage_generation,p.epoch)
      ))
    AND ((pg.id IS NULL AND (SELECT page_id FROM input) IS NULL AND e.page_id IS NULL)
      OR ((pg.observation,pg.registration,pg.definition,pg.consumer)=
        (o.observation,o.registration,r.definition,r.consumer)
        AND f.token IS NOT NULL
        AND (((SELECT execution_id FROM input) IS NULL AND pg.id=(SELECT start_id FROM input)
          AND pg.state='planned' AND pg.deadline=(SELECT deadline FROM input) AND pg.rounds=0 AND pg.pending IS NULL)
        OR ((SELECT execution_id FROM input) IS NOT NULL AND pg.id=st.id AND pg.state IN ('sealed','finished')
          AND pg.pending IS NULL AND pg.tail=e.id AND pg.tail_consumed IS NOT NULL AND pg.rounds BETWEEN 1 AND 3))))
), pending AS MATERIALIZED (
  -- The exact complete compiler closure is persisted by the original definition
  -- writer. LIMIT precedes every receiver-summary or own-row lookup.
  SELECT partition_no FROM semantic.public_filter_privacy_pending
  WHERE live AND input_key=ANY((SELECT coverage_keys FROM binding)::text[]) LIMIT 1
), fenced AS MATERIALIZED (
  SELECT partition_no FROM semantic.public_filter_privacy_head
  WHERE population_fenced AND NOT EXISTS(SELECT 1 FROM pending) LIMIT 1
), behind AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch FROM binding b
  CROSS JOIN LATERAL (
    SELECT source_home,source_epoch FROM search.public_filter_coverage_home h
    WHERE (h.partition_no,h.registration)=(b.partition_no,b.registration) AND h.behind
    ORDER BY source_home LIMIT 1
  ) h WHERE NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
), changed AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch FROM binding b
  CROSS JOIN LATERAL (
    SELECT source_home,source_epoch FROM search.public_filter_coverage_home h
    WHERE (h.partition_no,h.registration)=(b.partition_no,b.registration)
      AND h.last_change_generation>least(b.covered_generation,coalesce(b.start_generation,b.covered_generation))
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
), children AS MATERIALIZED (
  -- Separate exact-key paths: never enumerate the observation's prior history.
  SELECT * FROM (
    SELECT e.id,e.execution,e.consumer_window,e.page_ordinal,e.page_parent,e.page_consumed,e.page_size,e.page_raw,e.page_status
    FROM binding b JOIN search.public_filter_execution e ON (e.partition_no,e.page_id)=(b.partition_no,b.page_id)
    WHERE b.page_id IS NOT NULL AND (SELECT execution_id FROM input) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced) AND NOT EXISTS(SELECT 1 FROM heads)
    UNION ALL
    SELECT e.id,e.execution,e.consumer_window,e.page_ordinal,e.page_parent,e.page_consumed,e.page_size,e.page_raw,e.page_status
    FROM binding b JOIN search.public_filter_execution e ON
      (e.partition_no,e.observation,e.id)=(b.partition_no,b.observation,(SELECT execution_id FROM input))
    WHERE b.page_id IS NULL AND (SELECT execution_id FROM input) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced) AND NOT EXISTS(SELECT 1 FROM heads)
  ) actual ORDER BY page_ordinal LIMIT 3
), decoded AS MATERIALIZED (
  SELECT b.*,c.id AS child_id,c.page_ordinal,c.page_parent,c.page_consumed,c.page_size,c.page_status,
    semantic.public_filter_native_json(c.execution::jsonb) AS execution_value,
    semantic.public_filter_native_json(c.consumer_window::jsonb) AS window_value
  FROM binding b CROSS JOIN children c
), decoded_own AS MATERIALIZED (
  /* semantic.own-rows: every original and terminal, including rejects and repeats. */
  -- Decode the entire retained window before admitting any keyed control. Repeats
  -- remain in execution/raw accounting; a native control at this ONE snapshot is
  -- read once per exact key, rather than twice for every repeated original.
  SELECT k.id,b.bootstrap,b.partition_no,b.registration,
    coalesce((b.window_value->'raw'->(r.ordinality::integer-1)->'key'->>'owner')='accounts',false) AS account
  FROM decoded b CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(b.execution_value->'ownRows')='array' THEN b.execution_value->'ownRows' ELSE '[]'::jsonb END
  ) WITH ORDINALITY r(value,ordinality)
  CROSS JOIN LATERAL (VALUES (r.value->>'original'),(r.value->>'terminal')) k(id)
), own_keys AS MATERIALIZED (
  SELECT DISTINCT id,account,bootstrap,partition_no,registration,
    CASE WHEN id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (('x'||substr(id,25,4))::bit(16)::integer >> 4) END AS source_home
  FROM decoded_own
), home_keys AS MATERIALIZED (
  SELECT DISTINCT bootstrap,partition_no,registration,source_home FROM own_keys
), budgeted AS MATERIALIZED (
  -- Reserve the actual distinct composite keys, including misses, before either
  -- native control relation is dispatched. No accepted prefix of an oversized
  -- window can become authority. The raw window itself remains fully charged.
  SELECT * FROM binding WHERE (SELECT execution_id FROM input) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM decoded WHERE jsonb_typeof(execution_value->'ownRows') IS DISTINCT FROM 'array')
    AND (SELECT count(*) FROM decoded)=coalesce(page_rounds,1)
    AND NOT EXISTS (SELECT 1 FROM decoded WHERE page_id IS NOT NULL AND page_status IS DISTINCT FROM 'complete')
    AND NOT EXISTS (SELECT 1 FROM own_keys WHERE source_home IS NULL)
    AND 64+cardinality(coverage_keys)+5*(SELECT count(*) FROM home_keys)
      +2*(SELECT count(*) FROM own_keys WHERE NOT account)<=1000
), home_control AS MATERIALIZED (
  SELECT h.source_home,n.owner_epoch,n.population_fenced,base.source_epoch,
    base.native_revision,base.native_claim_revision,base.source_position
  FROM home_keys h CROSS JOIN budgeted b
  LEFT JOIN search.public_filter_coverage_baseline base ON
    (base.partition_no,base.registration,base.bootstrap,base.source_home)=
    (h.partition_no,h.registration,h.bootstrap,h.source_home)
  LEFT JOIN semantic.public_filter_privacy_head n ON n.partition_no=h.source_home
), subject_control AS MATERIALIZED (
  SELECT k.id,v.position,v.owner_epoch AS subject_epoch,h.source_epoch,h.source_position
  FROM own_keys k CROSS JOIN budgeted b JOIN home_control h ON h.source_home=k.source_home
  LEFT JOIN semantic.public_filter_privacy_subject v ON
    (v.partition_no,v.subject_id)=(k.source_home,k.id::uuid)
  WHERE NOT k.account
), admitted AS MATERIALIZED (
  SELECT b.* FROM binding b WHERE NOT EXISTS(SELECT 1 FROM pending) AND NOT EXISTS(SELECT 1 FROM fenced)
    AND NOT EXISTS(SELECT 1 FROM heads) AND ((SELECT execution_id FROM input) IS NULL
      OR EXISTS(SELECT 1 FROM budgeted))
    AND NOT EXISTS(SELECT 1 FROM home_control WHERE source_epoch IS NULL OR owner_epoch IS NULL
      OR population_fenced OR source_epoch<>owner_epoch)
    AND NOT EXISTS(SELECT 1 FROM own_keys k JOIN home_control h ON h.source_home=k.source_home
      WHERE k.account AND (h.native_revision IS NULL OR h.native_claim_revision IS NULL))
    AND NOT EXISTS(SELECT 1 FROM subject_control WHERE position IS NULL OR subject_epoch IS NULL
      OR subject_epoch<>source_epoch OR position>source_position)
), inserted AS (
  INSERT INTO semantic.public_filter_population_start
    (partition_no,id,registration,observation,bootstrap,read_definition,consumer,
     covered_generation,start_generation,owner_epoch,deadline)
  SELECT partition_no,(SELECT start_id FROM input),registration,observation,bootstrap,read_definition,consumer,
    covered_generation,coverage_generation,owner_epoch,(SELECT deadline FROM input) FROM admitted WHERE (SELECT execution_id FROM input) IS NULL
  RETURNING id
), started_page AS (
  UPDATE search.public_filter_coverage_page pg SET state='open',revision=revision+1
  FROM inserted i WHERE (pg.partition_no,pg.id)=(0,i.id) AND pg.state='planned'
  RETURNING pg.id
), finished_page AS (
  UPDATE search.public_filter_coverage_page pg SET state='finished',revision=revision+1
  FROM admitted b WHERE (pg.partition_no,pg.id)=(b.partition_no,b.page_id)
    AND (SELECT execution_id FROM input) IS NOT NULL AND pg.state='sealed'
  RETURNING pg.id
)
SELECT b.*, EXISTS(SELECT 1 FROM pending) AS pending,
  EXISTS(SELECT 1 FROM fenced) AS fenced,
  EXISTS(SELECT 1 FROM admitted) AS admitted,
  (SELECT id::text FROM inserted) AS inserted_start,
  (SELECT id::text FROM started_page) AS started_page,
  (SELECT id::text FROM finished_page) AS finished_page,
  coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.page_ordinal) FROM children c),'[]'::jsonb) AS page_children,
  coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM heads h),'[]'::jsonb) AS heads,
  (SELECT count(*)::integer FROM home_control) AS own_homes,
  (SELECT count(*)::integer FROM subject_control) AS own_subjects
FROM binding b;
