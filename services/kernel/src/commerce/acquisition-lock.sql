-- A conflicting writer forces SERIALIZABLE retry, never a stale post-wait snapshot.
INSERT INTO commerce.benefit_acquisition (route, buyer_account_id, benefit, slot_id, order_id)
VALUES (:route, :buyer_account_id, :benefit::text::jsonb, :slot_id, :order_id)
ON CONFLICT (route, buyer_account_id, benefit) DO UPDATE SET order_id = commerce.benefit_acquisition.order_id
RETURNING order_id AS "orderId";
