-- migrate:up
CREATE OR REPLACE FUNCTION semantic.public_filter_published_coverage(physical_target text, incarnation text, child_definition uuid, publication_job uuid, text_keys text[]
) RETURNS TABLE (
  job uuid, bootstrap uuid, registration text, definition uuid, consumer text,
  generation bigint, covered_generation bigint, coverage_root text, coverage_keys text[]
)
LANGUAGE sql STABLE AS $$
WITH candidates AS MATERIALIZED (
  SELECT j.* FROM search.generation_publication j
  WHERE j.partition_no=0 AND j.physical_target=$1 AND j.native_incarnation=$2
    AND j.family='subjects' AND j.phase='active' AND j.fence IS NULL
    AND ($4 IS NULL OR j.job=$4)
  LIMIT 2
)
SELECT j.job,b.bootstrap,r.id,d.read_definition,r.consumer,r.coverage_generation,b.coverage_generation,
       b.coverage_root,d.coverage_keys
FROM candidates j
-- Resolve every immutable publication reference by its unique native key.
-- A physical target, release or partition can host many other registrations and cuts.
JOIN LATERAL (
  SELECT b.* FROM semantic.public_filter_bootstrap b WHERE (b.partition_no,b.publication_job)=(0,j.job) LIMIT 1
) b ON j.bootstrap='0:'||b.bootstrap::text AND j.observation=b.publication_observation
  AND j.execution=b.publication_execution AND b.queried=j.observation AND b.state='adopted'
  AND b.snapshot_kind='prepared' AND b.coverage_sealed AND b.coverage_after=4096 AND b.account_after=4096
JOIN LATERAL (
  SELECT seal.complete,seal.ack_after FROM semantic.public_filter_repair_step seal
  WHERE (seal.partition_no,seal.bootstrap,seal.execution)=(0,b.bootstrap,b.publication_execution)
    AND seal.verified_root IS NOT NULL AND seal.verified_next IS NULL LIMIT 1
) seal ON seal.complete AND seal.ack_after=4096
JOIN LATERAL (
  SELECT o.* FROM search.public_filter_observation o WHERE (o.partition_no,o.observation)=(0,j.observation) LIMIT 1
) o ON o.consumer_bootstrap=j.bootstrap AND o.prepared_build=j.bootstrap AND o.state='open'
  AND o.expires_at>extract(epoch FROM statement_timestamp())*1000
JOIN LATERAL (
  SELECT r.* FROM search.public_filter_registration r WHERE (r.partition_no,r.id)=(0,o.registration) LIMIT 1
) r ON r.physical_target=j.physical_target AND r.state='active'
JOIN LATERAL (
  SELECT t.incarnation FROM search.public_filter_target t WHERE (t.partition_no,t.physical_target)=(0,r.physical_target) LIMIT 1
) t ON t.incarnation=j.native_incarnation
JOIN LATERAL (
  SELECT d.* FROM semantic.public_filter_read_definition d WHERE (d.partition_no,d.read_definition)=(0,b.read_definition) LIMIT 1
) d ON d.read_definition::text=j.binding->>'readDefinition' AND d.release_digest=j.consumer->>'meaningDigest'
JOIN LATERAL (
  SELECT child.* FROM semantic.public_filter_read_definition child WHERE (child.partition_no,child.read_definition)=(0,$3) LIMIT 1
) child ON (child.source_id,child.configuration,child.release_digest)=(d.source_id,d.configuration,d.release_digest)
  AND child.coverage_keys IS NOT NULL
CROSS JOIN LATERAL (
  SELECT s.owner_epoch FROM semantic.public_filter_source s
  WHERE (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration) LIMIT 1
) s
JOIN core.partition p ON p.partition_no=0 AND p.epoch=b.owner_epoch AND s.owner_epoch=p.epoch AND p.write_state='active'
JOIN LATERAL (
  SELECT c.* FROM search.public_filter_coverage_preparation c
  WHERE (c.partition_no,c.registration,c.bootstrap)=(0,r.id,b.bootstrap) LIMIT 1
) c ON c.population_protocol=1 AND c.after_home=4096 AND c.generation=b.coverage_generation
  AND c.root=b.coverage_root AND c.definition=d.read_definition AND c.consumer=r.consumer
JOIN LATERAL (
  SELECT last_home.root FROM search.public_filter_coverage_baseline last_home
  WHERE (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=(0,r.id,b.bootstrap,4095) LIMIT 1
) last_home ON last_home.root=c.root
WHERE (SELECT count(*) FROM candidates)=1
  AND '["scope","catalogue-text"]'=ANY(d.coverage_keys)
  AND child.coverage_keys <@ (d.coverage_keys || $5)
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.public_filter_published_coverage(physical_target text, incarnation text, child_definition uuid, publication_job uuid, text_keys text[]
) RETURNS TABLE (
  job uuid, bootstrap uuid, registration text, definition uuid, consumer text,
  generation bigint, covered_generation bigint, coverage_root text, coverage_keys text[]
)
LANGUAGE sql STABLE AS $$
WITH candidates AS MATERIALIZED (
  SELECT j.* FROM search.generation_publication j
  WHERE j.partition_no=0 AND j.physical_target=$1 AND j.native_incarnation=$2
    AND j.family='subjects' AND j.phase='active' AND j.fence IS NULL
    AND ($4 IS NULL OR j.job=$4)
  LIMIT 2
)
SELECT j.job,b.bootstrap,r.id,d.read_definition,r.consumer,r.coverage_generation,b.coverage_generation,
       b.coverage_root,d.coverage_keys
FROM candidates j
JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.publication_job)=(0,j.job)
  AND j.bootstrap='0:'||b.bootstrap::text AND j.observation=b.publication_observation
  AND j.execution=b.publication_execution AND b.queried=j.observation AND b.state='adopted'
  AND b.snapshot_kind='prepared' AND b.coverage_sealed AND b.coverage_after=4096 AND b.account_after=4096
JOIN semantic.public_filter_repair_step seal ON
  (seal.partition_no,seal.bootstrap,seal.execution)=(0,b.bootstrap,b.publication_execution)
  AND seal.verified_root IS NOT NULL AND seal.verified_next IS NULL AND seal.complete AND seal.ack_after=4096
JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,j.observation)
  AND o.consumer_bootstrap=j.bootstrap AND o.prepared_build=j.bootstrap AND o.state='open'
  AND o.expires_at>extract(epoch FROM statement_timestamp())*1000
JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(0,o.registration)
  AND r.physical_target=j.physical_target AND r.state='active'
JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(0,r.physical_target)
  AND t.incarnation=j.native_incarnation
JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(0,b.read_definition)
  AND d.read_definition::text=j.binding->>'readDefinition' AND d.release_digest=j.consumer->>'meaningDigest'
JOIN semantic.public_filter_read_definition child ON (child.partition_no,child.read_definition)=(0,$3)
  AND (child.source_id,child.configuration,child.release_digest)=(d.source_id,d.configuration,d.release_digest)
  AND child.coverage_keys IS NOT NULL
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no=0 AND p.epoch=b.owner_epoch AND s.owner_epoch=p.epoch AND p.write_state='active'
JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(0,r.id,b.bootstrap)
  AND c.population_protocol=1 AND c.after_home=4096 AND c.generation=b.coverage_generation
  AND c.root=b.coverage_root AND c.definition=d.read_definition AND c.consumer=r.consumer
JOIN search.public_filter_coverage_baseline last_home ON
  (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=(0,r.id,b.bootstrap,4095)
  AND last_home.root=c.root
WHERE (SELECT count(*) FROM candidates)=1
  AND '["scope","catalogue-text"]'=ANY(d.coverage_keys)
  AND child.coverage_keys <@ (d.coverage_keys || $5)
$$;
