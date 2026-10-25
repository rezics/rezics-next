SELECT count(*)::integer AS count FROM core.receipt
WHERE partition_no = :partition AND actor_account_id = :buyer
  AND command_kind = 'commerce.checkout.record'
  AND idempotency_key >= :prefix AND idempotency_key < :end;
