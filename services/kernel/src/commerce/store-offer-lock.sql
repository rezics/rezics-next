SELECT offer_id AS id, creator_account_id AS "creatorAccountId", target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition",
       title, currency, money_unit::text AS "moneyUnit", tax_behavior AS "taxBehavior", unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode",
       royalty_basis_points AS "royaltyBasisPoints", state, revision FROM commerce.offer WHERE route = :route AND offer_id = :id FOR UPDATE;
