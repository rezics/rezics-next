SELECT consumer_id FROM semantic.definition_catalogue_frontier
WHERE route=0 AND root_digest=:root::text ORDER BY slot LIMIT 1;
