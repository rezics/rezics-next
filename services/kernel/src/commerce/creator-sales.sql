SELECT order_id AS "orderId", offer_id AS "offerId", title,
       target_subject_id AS "targetSubjectId", currency,
       unit_amount_minor::text AS "unitAmountMinor", money_unit::text AS "moneyUnit",
       tax_behavior AS "taxBehavior", settlement, created_at::text AS "createdAt"
FROM commerce.creator_sale
WHERE route = :route AND creator_account_id = :creator_account_id AND order_id < :after::uuid
ORDER BY order_id DESC LIMIT :limit;
