-- member-retention: due-key seek
WITH input AS NOT MATERIALIZED (
  SELECT :after_purge_after::nullable(timestamptz) AS after_purge_after,
         :partition_no::integer AS partition_no, :cutoff::timestamptz AS cutoff,
         :page_limit::integer AS page_limit
)
SELECT * FROM (
  (SELECT purge_after::text AS "purgeAfter", route, collection_id::text AS "collectionId",
       member_id::text AS "memberId", deletion_id::text AS "deletionId"
   FROM library.collection_member CROSS JOIN input
   WHERE input.after_purge_after IS NULL
     AND collection_member.partition_no=input.partition_no AND purge_after<=input.cutoff AND deletion_id IS NOT NULL
   ORDER BY purge_after,route,collection_id,member_id LIMIT (SELECT page_limit FROM input))
  UNION ALL
  (SELECT purge_after::text AS "purgeAfter", route, collection_id::text AS "collectionId",
       member_id::text AS "memberId", deletion_id::text AS "deletionId"
   FROM library.collection_member CROSS JOIN input
   WHERE input.after_purge_after IS NOT NULL
     AND collection_member.partition_no=input.partition_no AND purge_after<=input.cutoff AND deletion_id IS NOT NULL
     AND (purge_after,route,collection_id,member_id)>
       (input.after_purge_after,:after_route::nullable(integer),:after_collection_id::nullable(uuid),:after_member_id::nullable(uuid))
   ORDER BY purge_after,route,collection_id,member_id LIMIT (SELECT page_limit FROM input))
) due ORDER BY "purgeAfter"::timestamptz,route,"collectionId","memberId";
