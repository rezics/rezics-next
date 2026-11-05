SELECT root_digest,slot,consumer_id,sequence::text
FROM semantic.definition_catalogue_frontier
WHERE route=0 AND consumer_root=:root::text ORDER BY consumer_id,slot LIMIT 100;
