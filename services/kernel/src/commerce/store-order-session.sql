UPDATE commerce.purchase_order SET checkout_session_id = :session_id, checkout_url = :url,
checkout_expires_at = :expires_at, updated_at = :time, revision = revision + 1, transaction_id = :transaction_id
WHERE route = :route AND order_id = :id RETURNING order_id AS id, buyer_account_id AS "buyerAccountId", offer_id AS "offerId",
       offer_revision AS "offerRevision", target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition", creator_account_id AS "creatorAccountId", title, currency,
       money_unit::text AS "moneyUnit", tax_behavior AS "taxBehavior", unit_amount_minor::text AS "unitAmountMinor", amount_tax_minor::text AS "amountTaxMinor", tax_code AS "taxCode", royalty_basis_points AS "royaltyBasisPoints",
       settlement, checkout_session_id AS "checkoutSessionId", checkout_url AS "checkoutUrl",
       checkout_expires_at::text AS "checkoutExpiresAt", observed_at::text AS "observedAt",
       created_at::text AS "createdAt", revision;
