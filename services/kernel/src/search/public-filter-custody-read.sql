SELECT r.definition, o.queried, o.covered, e.execution,
  CASE WHEN r.id IS NULL THEN 'definition_missing'
    WHEN r.state <> 'active' OR t.incarnation <> $4 THEN 'binding_mismatch'
    WHEN o.state <> 'open' OR o.expires_at <= $5 OR o.queried <> $3 THEN 'observation_lost'
    WHEN $6::text IS NOT NULL AND e.id IS NULL THEN 'execution_missing' END AS failure
FROM search.public_filter_observation o
LEFT JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
LEFT JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
LEFT JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=(o.partition_no,o.observation,$6)
WHERE (o.partition_no,o.observation)=($1,$2)
