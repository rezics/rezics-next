SELECT f.slot,f.consumer_id,f.sequence::text,f.closed_generation::text,
 f.consumer,f.provenance,f.dependency,f.enrollment_generation::text,f.consumer_state,
 c.state AS current_state,c.consumer AS current_consumer,c.provenance AS current_provenance,
 c.dependency AS current_dependency,c.enrollment_generation::text AS current_enrollment_generation
FROM (SELECT slot,consumer_id,sequence,closed_generation,consumer,provenance,dependency,enrollment_generation,consumer_state
 FROM semantic.definition_catalogue_frontier
 WHERE route=0 AND root_digest=:root::text ORDER BY slot LIMIT 100) f
LEFT JOIN semantic.definition_catalogue_consumer c ON c.route=0 AND c.root_digest=:previous::text AND c.id=f.consumer_id
ORDER BY f.slot;
