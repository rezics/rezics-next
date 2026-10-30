SELECT balance_transaction_id AS id, creator_account_id AS "creatorAccountId", order_id AS "orderId",
       offer_id AS "offerId", royalty_basis_points AS "royaltyBasisPoints", kind, currency,
       gross_minor::text AS "grossMinor", tax_minor::text AS "taxMinor", fee_minor::text AS "feeMinor",
       dispute_fee_minor::text AS "disputeFeeMinor", net_receipts_minor::text AS "netReceiptsMinor",
       stripe_created::text AS created
FROM commerce.royalty_line
WHERE route = :route AND balance_transaction_id = ANY(:ids::text[])
ORDER BY balance_transaction_id;
