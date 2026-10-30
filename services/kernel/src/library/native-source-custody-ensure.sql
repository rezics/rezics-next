INSERT INTO library.native_source_fence(route,kind,owner_id)
VALUES (:route,'collection',:collection_id),(:account_route,'account',:account_id)
ON CONFLICT (route,kind,owner_id) DO NOTHING;
