-- unbound: at most one short-lived hint per fixed topology home
WITH expired AS (
  DELETE FROM semantic.link_read_demand AS demand
  USING (
    SELECT partition_no FROM semantic.link_read_demand
    WHERE expires_at <= statement_timestamp()
    FOR UPDATE SKIP LOCKED
  ) AS expired_home
  WHERE demand.partition_no = expired_home.partition_no
)
SELECT partition.partition_no, partition.position
FROM semantic.link_read_demand AS demand
JOIN core.partition AS partition USING (partition_no)
LEFT JOIN core.consumer_checkpoint AS checkpoint
  ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = :consumer
WHERE demand.expires_at > statement_timestamp()
  AND partition.position > COALESCE(checkpoint.position, 0)
ORDER BY demand.expires_at, demand.partition_no;
