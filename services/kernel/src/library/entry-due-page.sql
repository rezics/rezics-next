WITH input AS NOT MATERIALIZED (
  SELECT :after_restore_until::nullable(timestamptz) AS after_restore_until
)
SELECT restore_until::text AS "restoreUntil", route,
       account_id::text AS "accountId", deletion_id::text AS "deletionId"
FROM library.entry_deleted
  CROSS JOIN input
WHERE partition_no = :partition_no::integer
  AND restore_until <= :cutoff::timestamptz
  AND (
    input.after_restore_until IS NULL
    OR (restore_until, route, account_id, deletion_id) > (
      input.after_restore_until, :after_route::nullable(integer),
      :after_account_id::nullable(uuid), :after_deletion_id::nullable(uuid)
    )
  )
ORDER BY restore_until, route, account_id, deletion_id
LIMIT :page_limit::integer;
