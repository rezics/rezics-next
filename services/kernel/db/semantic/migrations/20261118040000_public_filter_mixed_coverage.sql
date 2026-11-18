-- migrate:up
CREATE FUNCTION semantic.public_filter_mixed_coverage(physical_target text, incarnation text, child_definition uuid, parent_bootstrap uuid, encoded_consumer text) RETURNS TABLE(job uuid, bootstrap uuid, registration text, definition uuid, consumer text, generation bigint, covered_generation bigint, coverage_root text, coverage_keys text[])
LANGUAGE sql STABLE AS $$
SELECT b.bootstrap,b.bootstrap,r.id,d.read_definition,r.consumer,r.coverage_generation,b.coverage_generation,
       b.coverage_root,d.coverage_keys
FROM search.public_filter_registration r
JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
  AND t.incarnation=$2
JOIN search.discovery_generation g ON g.partition_no=0 AND g.state='active'
  AND g.prefix=regexp_replace(r.physical_target,'discovery-g[1-9][0-9]*$','')
  AND g.prefix||'discovery-g'||g.generation::text=r.physical_target AND g.index_uuid=t.incarnation
  AND g.capability->>'physicalTarget'=r.physical_target AND g.capability->>'uuid'=t.incarnation
  AND g.capability->>'incarnation'=g.incarnation::text
JOIN search.public_filter_coverage_home h ON (h.partition_no,h.registration,h.source_home)=(0,r.id,0)
  AND h.acknowledged_baseline=h.baseline_bootstrap AND NOT h.behind
JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,h.baseline_bootstrap)
  AND b.state='adopted' AND b.coverage_publication IS NULL AND b.publication_job IS NULL
  AND b.account_after=4096 AND b.coverage_after=4096 AND b.coverage_sealed
  AND b.queried=h.acknowledged_observation AND ($4 IS NULL OR b.bootstrap=$4)
JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,b.queried)
  AND o.registration=r.id AND o.consumer_bootstrap='0:'||b.bootstrap::text
  AND o.state='open' AND o.expires_at>extract(epoch FROM statement_timestamp())*1000
JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=(0,o.observation,h.acknowledged_execution)
  AND e.repair_settlement IS NOT NULL
JOIN LATERAL (SELECT semantic.public_filter_native_json(e.repair_settlement::jsonb) AS evidence) settled
  ON settled.evidence->>'id'=h.acknowledged_settlement AND settled.evidence->>'execution'=e.id
  AND settled.evidence->>'bootstrap'=o.consumer_bootstrap AND settled.evidence->>'closed'='true'
  AND settled.evidence->'fence'->>'incarnation'=t.incarnation
  AND settled.evidence->'fence'->>'sourceEpoch'=b.owner_epoch::text
  AND settled.evidence->'fence'->>'writeAlias'=r.physical_target||'-write'
JOIN semantic.public_filter_repair_step seal ON (seal.partition_no,seal.bootstrap,seal.execution)=(0,b.bootstrap,e.id)
  AND seal.verified_root IS NOT NULL AND seal.verified_next IS NULL AND seal.complete AND seal.ack_after=4096
JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(0,b.read_definition)
  AND d.read_definition=$3 AND '["domain","accounts"]'=ANY(d.coverage_keys)
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no=0 AND p.epoch=b.owner_epoch AND s.owner_epoch=p.epoch AND p.write_state='active'
JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(0,r.id,b.bootstrap)
  AND c.population_protocol=1 AND c.after_home=4096 AND c.generation=b.coverage_generation
  AND c.root=b.coverage_root AND c.definition=d.read_definition AND c.consumer=r.consumer
JOIN search.public_filter_coverage_baseline last_home ON
  (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=(0,r.id,b.bootstrap,4095)
  AND last_home.root=c.root
WHERE r.partition_no=0 AND r.physical_target=$1 AND r.state='active' AND md5(r.consumer)=md5($5) AND r.consumer=$5
  AND r.physical_target ~ 'discovery-g[1-9][0-9]*$'
$$;

-- migrate:down
DROP FUNCTION semantic.public_filter_mixed_coverage(text,text,uuid,uuid,text);
