SELECT kind, generation::text AS generation
FROM library.native_source_fence
WHERE (route,kind,owner_id) IN ((:route,'collection',:collection_id),(:account_route,'account',:account_id))
ORDER BY route,kind,owner_id FOR SHARE;
