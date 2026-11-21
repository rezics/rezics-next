WITH input AS MATERIALIZED (
  SELECT :after::integer AS after_home,
         statement_timestamp() - :retention_ms::bigint * interval '1 millisecond' AS cutoff
), due AS (
  (SELECT occurred_at, partition_no FROM content.feed_activity
   WHERE occurred_at <= (SELECT cutoff FROM input) ORDER BY occurred_at, partition_no LIMIT 1)
  UNION ALL
  (SELECT occurred_at, partition_no FROM content.feed_inbox
   WHERE occurred_at <= (SELECT cutoff FROM input) ORDER BY occurred_at, partition_no LIMIT 1)
)
SELECT CASE WHEN input.after_home < 0 THEN due.partition_no ELSE
  (SELECT p.partition_no FROM core.partition p WHERE p.partition_no > input.after_home ORDER BY p.partition_no LIMIT 1)
END AS partition_no
FROM due CROSS JOIN input ORDER BY due.occurred_at, due.partition_no LIMIT 1;
