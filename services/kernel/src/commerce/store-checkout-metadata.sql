UPDATE commerce.purchase_order SET observed_at = :observed_at, updated_at = :at,
 revision = revision + 1, transaction_id = :transaction_id
WHERE route = :route AND order_id = :id AND revision = :revision RETURNING revision;
