-- Only after the owning cleanup has revalidated a never-public private/unlisted head and deleted it
-- in this SAME command. Its DELETE trigger preserved the actual curator provenance on this exact control.
-- The account control is shared by other sources and must not be reset by ordinary cleanup.
WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :collection_id::uuid AS collection_id, :account_id::uuid AS account_id
)
DELETE FROM library.native_source_fence f USING input
WHERE f.route=input.route AND f.kind='collection' AND f.owner_id=input.collection_id
 AND f.account_id=input.account_id
 AND NOT EXISTS (SELECT 1 FROM library.collection c WHERE c.route=input.route AND c.collection_id=input.collection_id)
 AND NOT EXISTS (SELECT 1 FROM library.native_source_capture c WHERE c.route=input.route AND c.collection_id=input.collection_id)
RETURNING true AS removed;
