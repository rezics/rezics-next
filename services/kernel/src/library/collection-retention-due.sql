WITH input AS NOT MATERIALIZED (SELECT :after_time::nullable(timestamptz) AS after_time)
SELECT route, collection_id::text AS "collectionId", curator_account_id::text AS "accountId",
       deletion_id::text AS "deletionId", revision, purge_after::text AS "purgeAfter"
FROM library.collection CROSS JOIN input
WHERE partition_no = :partition_no::integer AND state = 'deleted' AND purge_after IS NOT NULL
  AND purge_after <= :cutoff::timestamptz
  AND (purge_after, route, collection_id) >
    (COALESCE(input.after_time, '-infinity'::timestamptz),
     COALESCE(:after_route::nullable(integer), 0),
     COALESCE(:after_id::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid))
ORDER BY purge_after, route, collection_id LIMIT 8;
