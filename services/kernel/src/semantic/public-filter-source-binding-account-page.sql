WITH admitted AS MATERIALIZED (
  SELECT b.partition_no, b.bootstrap
  FROM semantic.public_filter_bootstrap b JOIN core.partition p ON p.partition_no = b.partition_no
  WHERE b.partition_no = 0 AND b.bootstrap = :bootstrap::uuid AND b.state = 'capturing'
    AND b.account_after = :after_partition::integer AND p.epoch = b.owner_epoch AND p.write_state = 'active'
  FOR UPDATE OF b
), inserted AS (
  INSERT INTO semantic.public_filter_bootstrap_account
    (partition_no, bootstrap, account_partition, owner_epoch, revision, claim_revision)
  SELECT a.partition_no, a.bootstrap, h.partition, h.epoch, h.revision::bigint, h.claim_revision::bigint
  FROM admitted a CROSS JOIN jsonb_to_recordset(:heads::jsonb)
    AS h(partition integer, epoch integer, revision text, claim_revision text)
  RETURNING account_partition
)
UPDATE semantic.public_filter_bootstrap b
SET account_after = :next_partition::integer,
  state = CASE WHEN :next_partition::integer = 4096 THEN 'begun' ELSE 'capturing' END
WHERE b.partition_no = 0 AND b.bootstrap = :bootstrap::uuid
  AND (SELECT count(*) FROM inserted) = :head_count::integer
  AND EXISTS(SELECT 1 FROM admitted)
RETURNING b.bootstrap::text;
