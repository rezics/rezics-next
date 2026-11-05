SELECT count(*)::integer AS count FROM core.receipt
WHERE partition_no = :partition AND principal_kind = 'account' AND principal_id = :buyer
  AND command_kind = 'commerce.checkout.record'
  AND idempotency_key = ANY(:idempotency_keys::text[]);
