-- member-retention: due-key seek
WITH input AS NOT MATERIALIZED (
  SELECT :after_purge_after::nullable(timestamptz) AS after_purge_after
)
SELECT purge_after::text AS "purgeAfter", route, collection_id::text AS "collectionId",
       member_id::text AS "memberId", deletion_id::text AS "deletionId"
FROM library.collection_member CROSS JOIN input
WHERE partition_no=:partition_no::integer AND purge_after<=:cutoff::timestamptz AND deletion_id IS NOT NULL
  AND (input.after_purge_after IS NULL OR (purge_after,route,collection_id,member_id)>
    (input.after_purge_after,:after_route::nullable(integer),:after_collection_id::nullable(uuid),:after_member_id::nullable(uuid)))
ORDER BY purge_after,route,collection_id,member_id LIMIT :page_limit::integer;
