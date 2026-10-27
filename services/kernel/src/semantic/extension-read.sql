SELECT body
FROM semantic.context_extension
WHERE route = :route::integer AND context_id = :context_id::uuid AND digest = :digest::text;
