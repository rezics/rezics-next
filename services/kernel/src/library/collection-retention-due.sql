WITH input AS NOT MATERIALIZED (SELECT :after_time::nullable(timestamptz) AS after_time)
SELECT route, collection_id::text AS "collectionId", curator_account_id::text AS "accountId",
       deletion_id::text AS "deletionId", revision, purge_after::text AS "purgeAfter"
FROM library.collection CROSS JOIN input
WHERE partition_no = :partition_no::integer AND state = 'deleted' AND purge_after IS NOT NULL
  AND purge_after <= :cutoff::timestamptz
  AND (input.after_time IS NULL OR (purge_after, route, collection_id) >
    (input.after_time, :after_route::nullable(integer), :after_id::nullable(uuid)))
ORDER BY purge_after, route, collection_id LIMIT 8;
