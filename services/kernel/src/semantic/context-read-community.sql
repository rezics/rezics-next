SELECT 1 FROM semantic.context
WHERE route = :route::integer AND context_id = :context_id::uuid AND kind = 'community' AND state = 'active';
