SELECT position::text, transaction_id::text, cause, affected, impacts
FROM semantic.public_filter_privacy_log
WHERE partition_no = :partition_no::integer
  AND position > :after::bigint AND position <= :through::bigint
ORDER BY position
LIMIT :input_limit::integer;
