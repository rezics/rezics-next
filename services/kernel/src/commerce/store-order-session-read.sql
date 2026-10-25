SELECT order_id AS id, buyer_account_id AS "buyerAccountId", offer_id AS "offerId",
       offer_revision AS "offerRevision", creator_account_id AS "creatorAccountId", title, currency,
       unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode", royalty_basis_points AS "royaltyBasisPoints",
       settlement, checkout_session_id AS "checkoutSessionId", checkout_url AS "checkoutUrl",
       checkout_expires_at::text AS "checkoutExpiresAt", observed_at::text AS "observedAt",
       created_at::text AS "createdAt", revision FROM commerce.purchase_order WHERE route = :route AND checkout_session_id = :session_id;
