SELECT route, copy_id AS "copyId", account_id AS "accountId", deletion_id AS "deletionId",
       revision, restore_until::text AS "restoreUntil"
FROM library.copy
WHERE partition_no = :partition_no::integer AND deletion_id IS NOT NULL
  AND restore_until <= :cutoff::timestamptz
  AND (:after_time::nullable(timestamptz) IS NULL OR (restore_until, route, copy_id) >
    (:after_time::nullable(timestamptz), :after_route::nullable(integer), :after_copy::nullable(uuid)))
ORDER BY restore_until, route, copy_id
LIMIT 8;
