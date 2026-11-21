WITH input(physical,incarnation,claims,now_ms) AS (VALUES ($1::text,$2::text,$3::jsonb,$4::bigint)),
target AS MATERIALIZED (
  SELECT t.partition_no,t.physical_target FROM input,search.lock_retained_copy_target(0,input.physical) t
  WHERE t.incarnation=input.incarnation AND NOT EXISTS (
    SELECT 1 FROM search.identity_writer_gate g
    WHERE g.partition_no=0 AND g.physical_target=input.physical AND g.publication_fence IS NOT NULL
  )
), registered AS MATERIALIZED (
  SELECT t.partition_no,i.* FROM input CROSS JOIN target t
  JOIN search.public_filter_registration r USING(partition_no,physical_target)
  JOIN jsonb_to_recordset(input.claims) AS i(registration text,bootstrap uuid,observation text,
    consumer text,queried text,covered text,expires bigint,hash text,pit text)
    ON i.registration=r.id AND i.consumer=r.consumer
  WHERE r.state='active'
  ORDER BY r.id,i.bootstrap FOR SHARE OF r
), claimed AS (
  UPDATE search.public_filter_pit_claim c SET state='retained'
  FROM input,registered i,semantic.public_filter_bootstrap b
  WHERE (c.partition_no,c.registration,c.bootstrap)=(i.partition_no,i.registration,i.bootstrap)
    AND c.state='opening' AND c.consumer_work IS NOT NULL AND c.deadline>input.now_ms
    AND (b.partition_no,b.bootstrap)=(c.partition_no,c.bootstrap) AND b.state='begun'
    AND b.snapshot_kind='pit' AND b.queried IS NULL AND b.coverage_publication IS NOT NULL
    AND b.publication_job IS NULL
  RETURNING c.partition_no,c.bootstrap
), retained AS (
  INSERT INTO search.public_filter_observation(partition_no,observation,registration,queried,covered,expires_at,state)
  SELECT i.partition_no,i.observation,i.registration,i.queried,i.covered,i.expires,'open'
    FROM claimed c JOIN registered i USING(partition_no,bootstrap)
  RETURNING partition_no,observation
), owned AS (
  INSERT INTO search.public_filter_pit(partition_no,observation,id,locator,state)
  SELECT o.partition_no,o.observation,i.hash,i.pit,'owned'
    FROM retained o JOIN registered i USING(partition_no,observation)
  RETURNING observation
)
SELECT observation AS id FROM owned
