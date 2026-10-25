UPDATE commerce.offer
SET unit_amount_minor = CASE WHEN state = 'active' THEN :unit_amount_minor ELSE unit_amount_minor END,
    revision = CASE WHEN state = 'active' THEN revision + 1 ELSE revision END,
    updated_at = CASE WHEN state = 'active' THEN :time ELSE updated_at END,
    transaction_id = CASE WHEN state = 'active' THEN :transaction_id ELSE transaction_id END
WHERE route = :route AND offer_id = :id
RETURNING offer_id AS id, creator_account_id AS "creatorAccountId", target_subject_id AS "targetSubjectId",
          title, currency, unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode",
          royalty_basis_points AS "royaltyBasisPoints", state, revision;
