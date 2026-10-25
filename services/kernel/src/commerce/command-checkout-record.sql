UPDATE commerce.purchase_order
SET checkout_session_id = NULLIF(:session_id::text, ''), checkout_url = NULLIF(:url::text, ''),
    checkout_expires_at = NULLIF(:expires_at::text, '')::timestamptz,
    settlement = :settlement, updated_at = :at, revision = revision + 1, transaction_id = :transaction_id
WHERE route = :route AND order_id = :id AND revision = :revision
  AND checkout_session_id IS NULL AND settlement NOT IN ('failed', 'paid')
RETURNING revision;
