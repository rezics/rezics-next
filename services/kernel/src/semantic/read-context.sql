SELECT context_id::text AS id, kind, labels
FROM semantic.context
WHERE route = :route::integer AND context_id = :context_id::uuid;
