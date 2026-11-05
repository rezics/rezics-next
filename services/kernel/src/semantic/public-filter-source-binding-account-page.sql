WITH input AS (SELECT :bootstrap::uuid AS bootstrap, :next_partition::integer AS next_partition,
  :coverage_generation::bigint AS generation, :coverage_root::text AS root,
  :registration::text AS registration),
admitted AS MATERIALIZED (
  SELECT b.partition_no, b.bootstrap
  FROM semantic.public_filter_bootstrap b JOIN core.partition p ON p.partition_no = b.partition_no
  JOIN search.public_filter_coverage_preparation c
    ON (c.partition_no,c.registration,c.bootstrap)=(b.partition_no,(SELECT registration FROM input),b.bootstrap)
  WHERE b.partition_no = 0 AND b.bootstrap = (SELECT bootstrap FROM input) AND b.state = 'capturing'
    AND b.account_after = :after_partition::integer AND p.epoch = b.owner_epoch AND p.write_state = 'active'
    AND b.coverage_after = b.account_after AND b.coverage_generation = (SELECT generation FROM input)
    AND c.generation=b.coverage_generation AND c.after_home=(SELECT next_partition FROM input)
    AND c.root=(SELECT root FROM input) AND c.definition=b.read_definition
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
SET account_after = input.next_partition,
  coverage_after = input.next_partition, coverage_root = input.root,
  coverage_sealed = input.next_partition = 4096,
  state = CASE WHEN input.next_partition = 4096 THEN 'begun' ELSE 'capturing' END
FROM input
WHERE b.partition_no = 0 AND b.bootstrap = (SELECT bootstrap FROM input)
  AND (SELECT count(*) FROM inserted) = :head_count::integer
  AND EXISTS(SELECT 1 FROM admitted)
RETURNING b.bootstrap::text;
