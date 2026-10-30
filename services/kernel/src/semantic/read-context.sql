SELECT context_id::text AS id, kind, labels, settings_id, settings_release, defaults
FROM semantic.context
WHERE route = :route::integer AND context_id = :context_id::uuid AND state = 'active';
