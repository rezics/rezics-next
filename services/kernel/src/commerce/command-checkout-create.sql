UPDATE commerce.purchase_order
SET revision = revision + 1, updated_at = :at, transaction_id = :transaction_id
WHERE route = :route AND order_id = :id AND revision = :revision AND revision < 2147483647
RETURNING revision;
