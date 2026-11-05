INSERT INTO commerce.offer
(route, offer_id, creator_account_id, target_subject_id, content_edition, title, currency, unit_amount_minor, money_unit, tax_behavior, tax_code,
 royalty_basis_points, state, revision, created_at, updated_at, transaction_id)
VALUES (:route, :id, :creator_account_id, :target_subject_id, NULLIF(:content_edition::text, '')::jsonb, :title, :currency, :unit_amount_minor, NULLIF(:money_unit::text, '')::jsonb, NULLIF(:tax_behavior::text, ''), :tax_code,
 :royalty_basis_points, 'active', 1, :time, :updated_at, :transaction_id)
RETURNING offer_id AS id, creator_account_id AS "creatorAccountId", target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition",
       title, currency, money_unit::text AS "moneyUnit", tax_behavior AS "taxBehavior", unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode",
       royalty_basis_points AS "royaltyBasisPoints", state, revision;
