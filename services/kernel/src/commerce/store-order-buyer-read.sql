WITH input AS (SELECT :receipt::boolean AS receipt)
SELECT p.order_id AS id, p.buyer_account_id AS "buyerAccountId", p.offer_id AS "offerId",
       p.offer_revision AS "offerRevision", p.target_subject_id AS "targetSubjectId",
       p.content_edition::text AS "contentEdition", p.creator_account_id AS "creatorAccountId", p.title,
       p.currency, p.money_unit::text AS "moneyUnit", p.tax_behavior AS "taxBehavior",
       p.unit_amount_minor::text AS "unitAmountMinor", p.amount_tax_minor::text AS "amountTaxMinor",
       p.tax_code AS "taxCode", p.royalty_basis_points AS "royaltyBasisPoints", p.settlement,
       p.checkout_session_id AS "checkoutSessionId", p.checkout_url AS "checkoutUrl",
       p.checkout_expires_at::text AS "checkoutExpiresAt", p.observed_at::text AS "observedAt",
       p.created_at::text AS "createdAt", p.revision,
       (SELECT e.entitlement_id FROM commerce.entitlement e
        WHERE e.route = p.route AND e.order_id = p.order_id AND e.account_id = p.buyer_account_id) AS "entitlementId",
       CASE WHEN input.receipt AND p.settlement = 'paid' THEN (
         SELECT jsonb_build_object('moneyUnit', m.money_unit, 'amounts', m.amounts)::text
         FROM commerce.money_observation m
         WHERE m.route = p.route AND m.order_id = p.order_id
           AND m.provider_object_id = p.checkout_session_id AND m.context = 'checkout.integration'
           AND m.money_unit IS NOT NULL
         ORDER BY m.recorded_at DESC, m.provider_api_version DESC, m.economics_hash DESC LIMIT 1
       ) END AS "chargeEvidence",
       CASE WHEN input.receipt AND p.settlement = 'paid' THEN (
         SELECT jsonb_build_object('moneyUnit', m.money_unit, 'amounts', m.amounts)::text
         FROM commerce.money_observation m
         WHERE m.route = p.route AND m.order_id = p.order_id
           AND m.provider_object_id = p.checkout_session_id AND m.context = 'checkout.presentment'
           AND m.money_unit IS NOT NULL
         ORDER BY m.recorded_at DESC, m.provider_api_version DESC, m.economics_hash DESC LIMIT 1
       ) END AS "presentmentEvidence"
FROM commerce.purchase_order p CROSS JOIN input
WHERE p.route = :route AND p.order_id = :id AND p.buyer_account_id = :buyer_account_id;
