INSERT INTO library.native_source_fence(route,kind,owner_id,account_id)
VALUES (:route,'collection',:collection_id,:account_id),(:account_route,'account',:account_id,:account_id)
ON CONFLICT (route,kind,owner_id) DO UPDATE
SET account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id);
