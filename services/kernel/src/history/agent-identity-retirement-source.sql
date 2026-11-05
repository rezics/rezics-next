WITH input AS (SELECT $1::integer AS partition_no,$2::text AS source_key,$3::integer AS epoch,$4::bigint AS position)
SELECT s.custody_id,s.source,s.source_generation::text AS generation
FROM input i CROSS JOIN core.agent_identity_work_source s
JOIN core.partition p ON p.partition_no=s.partition_no AND p.write_state='active' AND p.epoch=i.epoch
JOIN core.history_family_domain d ON d.singleton AND d.generation=s.source_generation
WHERE s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.writer_version=1
  AND (s.source->>'partition')::integer=i.partition_no AND (s.source->>'epoch')::integer=i.epoch
  AND (s.source->>'position')::bigint=i.position AND p.position>=i.position
  AND (s.source->>'transactionId')::uuid=$5 AND s.source->>'digest'=$6
  AND s.source->>'release'=$7 AND s.source->>'workflowId'=$8 AND s.source->>'key'=i.source_key
FOR SHARE OF s,p,d;
