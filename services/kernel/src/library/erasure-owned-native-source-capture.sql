-- One raw account capture locator. The lower bound is an actual index coordinate, including generic plans.
-- At most the retained boundary key plus one next key is examined; no completed history walk.
WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :account_id::uuid AS account_id, :after_id::nullable(uuid) AS after_id
)
SELECT capture_id::text AS id, collection_id::text AS "collectionId"
FROM library.native_source_capture c, input
WHERE c.route=input.route AND c.account_id=input.account_id
 AND c.capture_id>=COALESCE(input.after_id,'00000000-0000-0000-0000-000000000000'::uuid)
 AND (input.after_id IS NULL OR c.capture_id<>input.after_id)
ORDER BY capture_id LIMIT 1;
