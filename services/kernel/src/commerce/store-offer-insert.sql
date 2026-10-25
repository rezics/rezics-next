INSERT INTO commerce.offer
(route, offer_id, creator_account_id, target_subject_id, title, currency, unit_amount_minor, tax_code,
 royalty_basis_points, state, revision, created_at, updated_at, transaction_id)
VALUES (:route, :id, :creator_account_id, :target_subject_id, :title, :currency, :unit_amount_minor, :tax_code,
 :royalty_basis_points, 'active', 1, :time, :updated_at, :transaction_id)
RETURNING offer_id AS id, creator_account_id AS "creatorAccountId", target_subject_id AS "targetSubjectId",
       title, currency, unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode",
       royalty_basis_points AS "royaltyBasisPoints", state, revision;
