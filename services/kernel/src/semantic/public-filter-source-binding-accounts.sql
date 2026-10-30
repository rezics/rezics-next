SELECT account_partition, owner_epoch, revision::text, claim_revision::text
FROM semantic.public_filter_bootstrap_account
WHERE partition_no = 0 AND bootstrap = :bootstrap::uuid
  AND account_partition >= :after_partition::integer
ORDER BY account_partition LIMIT 100;
