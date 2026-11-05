SELECT offer_id AS id, target_subject_id AS "targetSubjectId", title, currency,
       money_unit::text AS "moneyUnit", tax_behavior AS "taxBehavior",
       unit_amount_minor::text AS "unitAmountMinor", tax_code AS "taxCode",
       royalty_basis_points AS "royaltyBasisPoints", state, revision,
       content_edition::text AS "contentEdition"
FROM commerce.offer
WHERE route = :route AND creator_account_id = :creator_account_id AND offer_id < :after::uuid
ORDER BY offer_id DESC LIMIT :limit;
