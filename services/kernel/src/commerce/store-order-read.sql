WITH input AS (SELECT :receipt::boolean AS receipt)
SELECT order_id AS id, buyer_account_id AS "buyerAccountId", offer_id AS "offerId",
       offer_revision AS "offerRevision", target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition", creator_account_id AS "creatorAccountId", title, currency,
       money_unit::text AS "moneyUnit", tax_behavior AS "taxBehavior", unit_amount_minor::text AS "unitAmountMinor", amount_tax_minor::text AS "amountTaxMinor", tax_code AS "taxCode", royalty_basis_points AS "royaltyBasisPoints",
       settlement, checkout_session_id AS "checkoutSessionId", checkout_url AS "checkoutUrl",
       checkout_expires_at::text AS "checkoutExpiresAt", observed_at::text AS "observedAt",
       created_at::text AS "createdAt", revision,
       -- The existing partial index supplies one retained interpretation of this exact Session.
       -- Internal command reads do not need receipt evidence. No history walk or provider read.
       CASE WHEN input.receipt AND settlement = 'paid' THEN (
         SELECT jsonb_build_object('moneyUnit', m.money_unit, 'amounts', m.amounts)::text
         FROM commerce.money_observation m
         WHERE m.route = p.route AND m.order_id = p.order_id
           AND m.provider_object_id = p.checkout_session_id AND m.context = 'checkout.integration'
           AND m.money_unit IS NOT NULL
         ORDER BY m.recorded_at DESC, m.provider_api_version DESC, m.economics_hash DESC LIMIT 1
       ) END AS "chargeEvidence",
       CASE WHEN input.receipt AND settlement = 'paid' THEN (
         SELECT jsonb_build_object('moneyUnit', m.money_unit, 'amounts', m.amounts)::text
         FROM commerce.money_observation m
         WHERE m.route = p.route AND m.order_id = p.order_id
           AND m.provider_object_id = p.checkout_session_id AND m.context = 'checkout.presentment'
           AND m.money_unit IS NOT NULL
         ORDER BY m.recorded_at DESC, m.provider_api_version DESC, m.economics_hash DESC LIMIT 1
       ) END AS "presentmentEvidence"
FROM commerce.purchase_order p CROSS JOIN input WHERE route = :route AND order_id = :id;
