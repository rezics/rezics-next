UPDATE commerce.offer SET state = :state, revision = revision + 1, updated_at = :time, transaction_id = :transaction_id
WHERE route = :route AND offer_id = :id RETURNING offer_id AS id, creator_account_id AS "creatorAccountId", target_subject_id AS "targetSubjectId",
       title, currency, unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode",
       royalty_basis_points AS "royaltyBasisPoints", state, revision;
