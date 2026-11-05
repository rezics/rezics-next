-- Exact admitted order only. One native home; bounded fields before crossing the client boundary.
SELECT o.order_id AS "orderId", o.creator_account_id AS "creatorAccountId",
       o.offer_id AS "offerId", o.target_subject_id AS "targetSubjectId", o.title, o.currency,
       o.unit_amount_minor::text AS "unitAmountMinor", o.money_unit::text AS "moneyUnit",
       o.tax_behavior AS "taxBehavior", o.settlement, o.created_at::text AS "createdAt",
       o.revision, o.transaction_id AS "transactionId", a.state AS "buyerState",
       w.generation::text AS generation
FROM commerce.creator_sale_work w
JOIN commerce.purchase_order o ON (o.route,o.order_id)=(w.route,w.order_id)
JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
WHERE w.route=:route AND w.order_id=:order_id
  AND a.state <> 'deleted'
  AND octet_length(o.title)<=2048 AND char_length(o.title)<=512
  AND (o.money_unit IS NULL OR octet_length(o.money_unit::text)<=128);
