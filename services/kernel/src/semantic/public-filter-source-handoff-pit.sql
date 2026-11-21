/* semantic.native-keyed:25:47:3 */
WITH input(bootstrap,registration,observation,now_ms,previous_work,adopted_work,queried,covered,source_consumer,
           read_definition,publication,generation,digest,capture,dependencies,route_digest,source_id,configuration,
           physical_target,search_consumer,definition,incarnation,text_keys) AS (
  VALUES ($1::uuid,$2::text,$3::text,$4::bigint,$5::text,$6::text,$7::text,$8::text,$9::text,$10::uuid,
          $11::uuid,$12::bigint,$13::text,$14::text,$15::jsonb,$16::text,$17::uuid,$18::uuid,$19::text,
          $20::text,$21::text,$22::text,$23::text[])
), authority AS MATERIALIZED (
  -- The invocation names one Source definition and one Search registration. Resolve
  -- their current witnesses independently before locking the three mutable receipts.
  SELECT i.*,p.epoch AS owner_epoch
  FROM input i
  JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(0,i.read_definition)
  JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(d.partition_no,d.source_id,d.configuration)
  JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=s.owner_epoch AND p.write_state='active'
  WHERE d.release_digest=i.digest AND d.capture=i.capture AND d.dependency_keys=i.dependencies
    AND s.route_digest=i.route_digest AND s.source_id=i.source_id AND s.configuration=i.configuration
), registration AS MATERIALIZED (
  SELECT a.*
  FROM authority a
  JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(0,a.registration)
  JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
  WHERE r.state='active' AND r.physical_target=a.physical_target AND r.consumer=a.search_consumer
    AND r.definition=a.definition AND t.incarnation=a.incarnation
), retained AS MATERIALIZED (
  SELECT b.partition_no,b.bootstrap,c.registration,o.observation,i.adopted_work
  FROM registration i JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,i.bootstrap)
  JOIN search.public_filter_pit_claim c ON (c.partition_no,c.bootstrap)=(b.partition_no,b.bootstrap)
  JOIN search.public_filter_observation o ON (o.partition_no,o.registration,o.observation)=(c.partition_no,c.registration,i.observation)
  WHERE c.registration=i.registration AND b.owner_epoch=i.owner_epoch AND b.state='begun' AND b.queried IS NULL
    AND b.snapshot_kind='pit' AND b.publication_job IS NULL AND b.consumer=i.source_consumer
    AND b.read_definition=i.read_definition AND b.coverage_publication=i.publication AND b.coverage_generation=i.generation
    AND c.state='retained' AND c.deadline>i.now_ms AND c.consumer_work=i.previous_work
    AND o.state='open' AND o.expires_at>i.now_ms AND o.consumer_work IS NULL AND o.queried=i.queried AND o.covered=i.covered
    AND (EXISTS (SELECT FROM semantic.definition_release WHERE route=0 AND digest=i.digest)
      OR EXISTS (SELECT FROM semantic.release_composite WHERE digest=i.digest))
    AND EXISTS (SELECT FROM semantic.public_filter_published_coverage(i.physical_target,i.incarnation,i.read_definition,b.coverage_publication,i.text_keys) population
                WHERE population.generation>=b.coverage_generation)
  FOR UPDATE OF c,b,o
), adopted AS (
  UPDATE semantic.public_filter_bootstrap b SET state='adopted',queried=r.observation FROM retained r
  WHERE (b.partition_no,b.bootstrap)=(r.partition_no,r.bootstrap) RETURNING r.*
), moved AS (
  UPDATE search.public_filter_observation o SET consumer_work=a.adopted_work,consumer_bootstrap=a.observation FROM adopted a
  WHERE (o.partition_no,o.observation)=(a.partition_no,a.observation) RETURNING a.partition_no,a.bootstrap
)
UPDATE search.public_filter_pit_claim c SET state='handed',consumer_work=NULL FROM moved m
WHERE (c.partition_no,c.bootstrap)=(m.partition_no,m.bootstrap) RETURNING c.bootstrap
