SELECT balance_transaction_id AS "balanceTransactionId", order_id AS "orderId", offer_id AS "offerId",
       creator_account_id AS "creatorAccountId", currency, money_unit::text AS "moneyUnit", kind, stripe_created::text AS created,
       gross_minor::text AS "grossMinor", tax_minor::text AS "taxMinor", fee_minor::text AS "feeMinor",
       dispute_fee_minor::text AS "disputeFeeMinor", net_receipts_minor::text AS "netReceiptsMinor",
       royalty_basis_points AS "royaltyBasisPoints", period, statement_id AS "statementId",
       recorded_at::text AS "recordedAt"
FROM commerce.royalty_line WHERE route = :route AND statement_id = :id
AND balance_transaction_id > :after ORDER BY balance_transaction_id LIMIT :limit;
