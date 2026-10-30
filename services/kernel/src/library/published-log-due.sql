WITH args AS (
  SELECT :partition_no::integer AS partition_no, :cutoff::timestamptz AS cutoff,
         :after_time::nullable(timestamptz) AS after_time,
         :after_route::nullable(integer) AS after_route,
         :after_id::nullable(uuid) AS after_id, :limit::integer AS page_limit
)
SELECT log.route, log.log_id AS "logId", log.account_id AS "accountId", log.deletion_id AS "deletionId",
       log.revision, log.restore_until::text AS "restoreUntil"
FROM library.published_log AS log CROSS JOIN args
WHERE log.partition_no = args.partition_no AND log.deleted AND log.restore_until IS NOT NULL
  AND log.restore_until <= args.cutoff
  AND (args.after_time IS NULL OR (log.restore_until, log.route, log.log_id) >
    (args.after_time, args.after_route, args.after_id))
ORDER BY log.restore_until, log.route, log.log_id
LIMIT (SELECT page_limit FROM args);
