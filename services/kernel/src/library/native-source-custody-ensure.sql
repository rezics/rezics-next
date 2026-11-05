WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
        :account_route::integer AS account_route, :account_id::uuid AS account_id
)
INSERT INTO library.native_source_fence(route,kind,owner_id,account_id)
SELECT route,'collection',collection_id,account_id FROM input
UNION ALL SELECT account_route,'account',account_id,account_id FROM input
ON CONFLICT (route,kind,owner_id) DO UPDATE
SET account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id);
