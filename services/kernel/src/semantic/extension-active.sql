SELECT digest, head
FROM semantic.context_extension_head(:route::integer, :context_id::uuid)
LIMIT 1;
