SELECT offer_id FROM commerce.offer
WHERE route = :route AND offer_id = :id AND creator_account_id = :creator
  AND transaction_id = :transaction_id AND revision = 1 AND created_at = :at
  AND xmin = pg_current_xact_id()::xid;
