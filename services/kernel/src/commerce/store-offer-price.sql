UPDATE commerce.offer
SET unit_amount_minor = CASE WHEN state = 'active' THEN :unit_amount_minor ELSE unit_amount_minor END,
    money_unit = CASE WHEN state = 'active' THEN :money_unit::text::jsonb ELSE money_unit END,
    tax_behavior = CASE WHEN state = 'active' THEN :tax_behavior::text ELSE tax_behavior END,
    revision = CASE WHEN state = 'active' THEN revision + 1 ELSE revision END,
    updated_at = CASE WHEN state = 'active' THEN :time ELSE updated_at END,
    transaction_id = CASE WHEN state = 'active' THEN :transaction_id ELSE transaction_id END
WHERE route = :route AND offer_id = :id
RETURNING offer_id AS id, creator_account_id AS "creatorAccountId", target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition",
          title, currency, money_unit::text AS "moneyUnit", tax_behavior AS "taxBehavior", unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode",
          royalty_basis_points AS "royaltyBasisPoints", state, revision;
