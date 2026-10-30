WITH page AS MATERIALIZED (
  SELECT route, buyer_account_id, order_id, offer_id, offer_revision, title, target_subject_id, currency,
         unit_amount_minor, tax_code, amount_tax_minor, settlement,
         checkout_url, checkout_expires_at, created_at
  FROM commerce.purchase_order
  WHERE route = :route AND buyer_account_id = :buyer_account_id AND order_id < :after::uuid
  ORDER BY order_id DESC LIMIT :limit
)
SELECT p.order_id AS id, p.offer_id AS "offerId", p.offer_revision AS "offerRevision",
       p.title, p.target_subject_id AS "targetSubjectId", p.currency,
       p.unit_amount_minor::text AS "unitAmountMinor", p.tax_code AS "taxCode",
       p.amount_tax_minor::text AS "amountTaxMinor", p.settlement,
       p.checkout_url AS "checkoutUrl", p.checkout_expires_at::text AS "checkoutExpiresAt",
       p.created_at::text AS "createdAt",
       (SELECT e.entitlement_id FROM commerce.entitlement e
        WHERE e.route = p.route AND e.order_id = p.order_id AND e.account_id = p.buyer_account_id) AS "entitlementId"
FROM page p ORDER BY p.order_id DESC;
