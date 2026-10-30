INSERT INTO commerce.purchase_order
(route, order_id, buyer_account_id, offer_id, offer_revision, target_subject_id, content_edition, creator_account_id, title, currency,
 unit_amount_minor, money_unit, tax_behavior, tax_code, royalty_basis_points, settlement, created_at, updated_at, revision, transaction_id)
VALUES (:route, :id, :buyer_account_id, :offer_id, :offer_revision, :target_subject_id, NULLIF(:content_edition::text, '')::jsonb, :creator_account_id, :title, :currency,
 :unit_amount_minor, NULLIF(:money_unit::text, '')::jsonb, NULLIF(:tax_behavior::text, ''), :tax_code, :royalty_basis_points, 'pending', :time, :updated_at, 1, :transaction_id)
RETURNING order_id AS id, buyer_account_id AS "buyerAccountId", offer_id AS "offerId",
       offer_revision AS "offerRevision", target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition", creator_account_id AS "creatorAccountId", title, currency,
       money_unit::text AS "moneyUnit", tax_behavior AS "taxBehavior", unit_amount_minor::text AS "unitAmountMinor", amount_tax_minor::text AS "amountTaxMinor", tax_code AS "taxCode", royalty_basis_points AS "royaltyBasisPoints",
       settlement, checkout_session_id AS "checkoutSessionId", checkout_url AS "checkoutUrl",
       checkout_expires_at::text AS "checkoutExpiresAt", observed_at::text AS "observedAt",
       created_at::text AS "createdAt", revision;
