-- Bind each planned page or sealed tail to its exact observed definition and lease.
WITH clock AS (SELECT $2::bigint AS deadline_now)
SELECT i.slot,o.observation,o.registration,o.queried,o.covered,r.consumer,r.definition,b.bootstrap,
  b.read_definition,b.consumer AS bootstrap_consumer,b.snapshot_kind,b.book_withdrawals,b.owner_epoch,
  b.coverage_publication,b.coverage_generation AS covered_generation,st.start_generation,
  d.release_digest,d.source_id,d.configuration,d.capture,d.dependency_keys,d.coverage_keys,
  pg.id AS page_id,pg.state AS page_state,pg.rounds AS page_rounds,pg.boundary,pg.boundary_consumed,pg.boundary_window,
  pg.charged AS page_charged,pg.ceiling AS page_ceiling,pg.tail AS page_tail,pg.tail_consumed,
  coalesce(children.windows,'[]'::jsonb) AS page_children
FROM jsonb_to_recordset($1::jsonb) i(slot integer,observation text,queried text,consumer text,
  physical_target text,start_id uuid,execution_id text,deadline bigint)
CROSS JOIN LATERAL (
  SELECT * FROM search.public_filter_coverage_page WHERE (partition_no,id)=(0,i.start_id) LIMIT 1
) pg
CROSS JOIN LATERAL (
  SELECT * FROM search.public_filter_observation WHERE (partition_no,observation)=(0,i.observation) LIMIT 1
) o
CROSS JOIN LATERAL (
  SELECT * FROM search.public_filter_registration WHERE (partition_no,id)=(0,o.registration) LIMIT 1
) r
CROSS JOIN LATERAL (
  SELECT expires_at FROM search.public_filter_reference WHERE (partition_no,observation,token)=(0,o.observation,pg.reference_token) LIMIT 1
) f
CROSS JOIN LATERAL (
  SELECT * FROM semantic.public_filter_bootstrap WHERE partition_no=0 AND bootstrap=
    CASE WHEN o.consumer_bootstrap ~ '^0:[0-9a-f-]{36}$' THEN substr(o.consumer_bootstrap,3)::uuid END LIMIT 1
) b
CROSS JOIN LATERAL (
  SELECT * FROM semantic.public_filter_read_definition WHERE (partition_no,read_definition)=(0,b.read_definition) LIMIT 1
) d
LEFT JOIN LATERAL (
  SELECT * FROM semantic.public_filter_population_start WHERE i.execution_id IS NOT NULL AND (partition_no,id)=(0,pg.id) LIMIT 1
) st ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.page_ordinal) AS windows FROM (
    SELECT e.id,e.execution,e.consumer_window,e.page_ordinal,e.page_parent,e.page_consumed,e.page_size,e.page_raw,e.page_status
    FROM search.public_filter_execution e WHERE (e.partition_no,e.page_id,e.observation)=(0,pg.id,o.observation)
      AND i.execution_id IS NOT NULL ORDER BY e.page_ordinal LIMIT 3
  ) c
) children ON true
WHERE (pg.observation,pg.registration,pg.definition,pg.consumer)=(o.observation,r.id,r.definition,r.consumer)
  AND pg.deadline=i.deadline AND pg.deadline>(SELECT deadline_now FROM clock) AND f.expires_at>(SELECT deadline_now FROM clock) AND pg.pending IS NULL
  AND o.state='open' AND o.expires_at>(SELECT deadline_now FROM clock) AND o.queried=i.queried
  AND r.state='active' AND r.consumer=i.consumer AND r.physical_target=i.physical_target
  AND b.state='adopted' AND b.queried=o.observation AND b.snapshot_kind='pit'
  AND b.coverage_publication IS NOT NULL AND b.coverage_generation IS NOT NULL AND d.coverage_keys IS NOT NULL
  AND ((i.execution_id IS NULL AND pg.state='planned' AND pg.rounds=0)
    OR (pg.state IN ('sealed','finished') AND pg.tail=i.execution_id AND pg.tail_consumed IS NOT NULL
      AND pg.rounds BETWEEN 1 AND 3 AND (st.registration,st.observation,st.bootstrap,st.read_definition,st.consumer,
        st.covered_generation,st.owner_epoch)=(r.id,o.observation,b.bootstrap,b.read_definition,r.consumer,
        b.coverage_generation,b.owner_epoch)))
ORDER BY i.slot
