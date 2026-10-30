SELECT kind
FROM semantic.context
WHERE route = :route::integer AND context_id = :context_id::uuid AND state = 'active';
